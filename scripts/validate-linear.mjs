#!/usr/bin/env node
// Validate every GraphQL operation the Linear client sends, and the variables the commands pass,
// against Linear's published schema. Needs network access; no Linear account or key is used.
import { buildSchema, parse, validate } from "graphql";
import { getVariableValues } from "graphql/execution/values.js";
import { LinearClient } from "../src/linear.ts";

const SCHEMA_URL = "https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql";
const response = await fetch(SCHEMA_URL);
if (!response.ok) throw new Error(`Could not fetch the Linear schema: HTTP ${response.status}`);
const schema = buildSchema(await response.text());

const sent = [];
const client = new LinearClient("unused", async (_url, init) => {
	sent.push(JSON.parse(init.body));
	return { ok: true, status: 200, json: async () => ({ errors: [{ message: "recorded" }] }), text: async () => "" };
});
const record = async (name, call) => {
	await call().catch(() => {});
	sent.at(-1).name = name;
};

// Keep these in step with the filters the commands build (src/commands/*.ts, src/tools.ts).
const team = { team: { key: { eq: "ENG" } } };
const label = { labels: { some: { name: { eq: "repo:x" } } } };
await record("viewer", () => client.viewer());
await record("team", () => client.team("ENG"));
await record("workflowStates", () => client.workflowStates("ENG"));
await record("labelId", () => client.labelId("blocked", "team-id"));
await record("issue", () => client.issue("ENG-1"));
await record("comments (paged)", () => client.comments("ENG-1"));
await record("issues: /work next, mine", () => client.issues({ ...team, assignee: { isMe: { eq: true } }, state: { id: { in: ["s1", "s2"] } } }, 50));
await record("issues: /work next, unassigned", () => client.issues({ ...team, assignee: { null: true }, state: { id: { eq: "s1" } }, ...label }, 50));
await record("issues: /work next, backlog slices", () => client.issues({ ...team, state: { id: { eq: "s3" } }, description: { contains: "**pi-team**" }, ...label }, 50));
await record("issues: started", () => client.issues({ ...team, state: { type: { eq: "started" } } }));
await record("issues: /team status", () => client.issues({ ...team, state: { id: { eq: "s1" } } }));
await record("issues: search", () =>
	client.issues({ ...team, state: { type: { nin: ["completed", "canceled"] } }, and: [{ or: [{ title: { containsIgnoreCase: "q" } }, { description: { containsIgnoreCase: "q" } }] }] }, 30),
);
await record("issues: slice keys", () => client.issues({ ...team, or: [{ description: { contains: "spec/slice" } }] }, 100));
await record("project", () => client.project("Acme"));
await record("createProject", () => client.createProject({ name: "Acme", description: "d", teamIds: ["t"] }));
await record("issues: /discover sources", () => client.issues({ ...team, or: [{ description: { contains: "tasks/T001.md" } }] }, 500));
await record("createIssue", () => client.createIssue({ teamId: "t", title: "x", description: "d", labelIds: ["l"], projectId: "p", stateId: "s" }));
await record("createBlocksRelation", () => client.createBlocksRelation("a", "b"));
await record("comment", () => client.comment("i", "body"));
await record("updateIssue", () => client.updateIssue("i", { stateId: "s", assigneeId: "u", addedLabelIds: ["l"], removedLabelIds: ["m"] }));

let failures = 0;
for (const { name, query, variables } of sent) {
	const document = parse(query);
	const errors = [...validate(schema, document)];
	const coerced = getVariableValues(schema, document.definitions[0].variableDefinitions ?? [], variables ?? {});
	if (coerced.errors) errors.push(...coerced.errors);
	console.log(`${errors.length ? "FAIL" : "ok  "} ${name}`);
	for (const error of errors) console.log(`     ${error.message}`);
	failures += errors.length;
}
console.log(failures ? `${failures} problem(s)` : `${sent.length} operations valid against Linear's schema`);
process.exit(failures ? 1 : 0);
