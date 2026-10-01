import assert from "node:assert/strict";
import { test } from "node:test";
import { type FetchLike, LinearClient, LinearError, linearUrl } from "../src/linear.ts";
import { FakeLinear, USERS } from "./fake-linear.ts";

function fake(handler: (body: { query: string; variables: Record<string, unknown> }, headers: Record<string, string>) => { status?: number; json?: unknown; throws?: Error }) {
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
	const fetchImpl: FetchLike = async (_url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		const result = handler(body, init.headers);
		if (result.throws) throw result.throws;
		const status = result.status ?? 200;
		return { ok: status < 400, status, json: async () => result.json, text: async () => JSON.stringify(result.json ?? "") };
	};
	return { client: new LinearClient("lin_api_key", fetchImpl, 1000), calls };
}

test("sends the personal API key and returns data", async () => {
	let auth = "";
	const { client } = fake((_b, headers) => {
		auth = headers.Authorization;
		return { json: { data: { viewer: { id: "u1", name: "Dan", email: "d@x" } } } };
	});
	assert.deepEqual(await client.viewer(), { id: "u1", name: "Dan", email: "d@x" });
	assert.equal(auth, "lin_api_key");
});

test("GraphQL errors are certain failures", async () => {
	const { client } = fake(() => ({ json: { errors: [{ message: "bad input" }] } }));
	await assert.rejects(client.comment("i1", "x"), (e: LinearError) => e instanceof LinearError && !e.uncertain && /bad input/.test(e.message));
});

test("network failures and 5xx on writes are uncertain; on reads they are not", async () => {
	const network = fake(() => ({ throws: new Error("socket hang up") }));
	await assert.rejects(network.client.comment("i1", "x"), (e: LinearError) => e.uncertain);
	await assert.rejects(network.client.viewer(), (e: LinearError) => !e.uncertain);
	const server = fake(() => ({ status: 502, json: "bad gateway" }));
	await assert.rejects(server.client.createIssue({ teamId: "t", title: "x", description: "d" }), (e: LinearError) => e.uncertain);
	const client4xx = fake(() => ({ status: 400, json: "bad" }));
	await assert.rejects(client4xx.client.comment("i1", "x"), (e: LinearError) => !e.uncertain);
});

test("an unreadable response to a write is uncertain", async () => {
	const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>"), text: async () => "<html>" });
	const client = new LinearClient("k", fetchImpl, 1000);
	await assert.rejects(client.comment("i1", "x"), (e: LinearError) => e.uncertain && e.kind === "network");
	await assert.rejects(client.viewer(), (e: LinearError) => !e.uncertain);
});

test("a stalled response body times out instead of hanging", async () => {
	const fetchImpl: FetchLike = async (_url, init) => ({
		ok: true,
		status: 200,
		json: () => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		text: async () => "",
	});
	const started = Date.now();
	await assert.rejects(new LinearClient("k", fetchImpl, 50).viewer(), /unreadable: aborted/);
	assert.ok(Date.now() - started < 2000);
});

test("only Linear saying so means an issue does not exist", async () => {
	const missing = fake(() => ({ json: { errors: [{ message: "Entity not found: Issue" }] } }));
	assert.equal(await missing.client.issue("ENG-404"), undefined);
	const http404 = fake(() => ({ status: 404, json: "Not Found" }));
	await assert.rejects(http404.client.issue("ENG-1"), (e: LinearError) => e.kind === "http");
	const outage = fake(() => ({ throws: new Error("getaddrinfo ENOTFOUND api.linear.app") }));
	await assert.rejects(outage.client.issue("ENG-1"), (e: LinearError) => e.kind === "network");
});

function seeded(): { linear: FakeLinear; client: LinearClient } {
	const linear = new FakeLinear();
	return { linear, client: new LinearClient("k", linear.fetch, 1000) };
}

test("issue normalises blockers, blocked issues and every page of comments", async () => {
	const { linear, client } = seeded();
	linear.add("ENG-1", { state: "In Progress" });
	linear.add("ENG-2", { assignee: USERS.sam.id, labels: ["blocked"], project: "Tenancy" });
	linear.add("ENG-3", { state: "Backlog" });
	linear.blocks("ENG-1", "ENG-2");
	linear.blocks("ENG-2", "ENG-3");
	for (let i = 0; i < 120; i++) linear.comment("ENG-2", `comment ${i}`, USERS.sam.id);

	const issue = await client.issue("ENG-2");
	assert.deepEqual(issue?.blockers.map((b) => [b.identifier, b.state.name]), [["ENG-1", "In Progress"]]);
	assert.deepEqual(issue?.blocks.map((b) => b.identifier), ["ENG-3"]);
	assert.deepEqual(issue?.assignee, { id: USERS.sam.id, name: "Sam" });
	assert.deepEqual(issue?.project, { id: "project-Tenancy", name: "Tenancy" });
	assert.equal(issue?.comments.length, 120, "comments beyond the first page are not dropped");
	assert.equal(issue?.comments.at(-1)?.body, "comment 119");
	assert.equal(issue?.comments[0].author, "Sam");
	assert.equal((await client.comments("ENG-2")).length, 120);
	assert.equal((await client.issue("ENG-1"))?.project, undefined);
});

test("issue lists carry open blockers, page through results and say when more exist", async () => {
	const { linear, client } = seeded();
	for (let i = 1; i <= 130; i++) linear.add(`ENG-${i}`);
	linear.get("ENG-3").state = "Done";
	linear.blocks("ENG-2", "ENG-1");
	linear.blocks("ENG-3", "ENG-1");

	const all = await client.issues({ team: { key: { eq: "ENG" } } });
	assert.equal(all.length, 130);
	assert.equal(all.more, false);
	assert.deepEqual(all[0].openBlockers, ["ENG-2"], "a completed blocker is not open");

	const capped = await client.issues({ team: { key: { eq: "ENG" } } }, 60);
	assert.equal(capped.length, 60);
	assert.equal(capped.more, true);
	const pages = linear.requests.filter((r) => r.query.includes("issues(")).slice(-2);
	assert.deepEqual(pages.map((r) => [r.variables.first, r.variables.after]), [[50, null], [10, "50"]]);
	assert.equal((await client.issues({ state: { id: { in: ["state-Done"] } } })).length, 1);
});

test("the endpoint override is honoured only for loopback", () => {
	assert.equal(linearUrl(undefined), "https://api.linear.app/graphql");
	assert.equal(linearUrl("http://127.0.0.1:4000/graphql"), "http://127.0.0.1:4000/graphql");
	assert.equal(linearUrl("http://localhost:4000/graphql"), "http://localhost:4000/graphql");
	for (const hostile of ["https://evil.example/graphql", "http://127.0.0.1.evil.example/graphql", "http://evil.example/?x=127.0.0.1", "not a url"]) {
		assert.equal(linearUrl(hostile), "https://api.linear.app/graphql", hostile);
	}
});

test("a server that never finishes paging cannot make the client loop forever", async () => {
	let requests = 0;
	const fetchImpl: FetchLike = async () => {
		requests++;
		return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } }), text: async () => "" };
	};
	const list = await new LinearClient("k", fetchImpl, 1000).issues({});
	assert.equal(requests, 1);
	assert.equal(list.length, 0);
});

test("a relation Linear refuses to create is an error, not a silent success", async () => {
	const { client } = fake(() => ({ json: { data: { issueRelationCreate: { success: false } } } }));
	await assert.rejects(client.createBlocksRelation("a", "b"), /reported failure/);
});
