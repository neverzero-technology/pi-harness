import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike } from "../src/linear.ts";

// An in-memory stand-in for the parts of Linear the client uses. It answers by recognising each
// operation, so it proves the client's handling of responses, not Linear's behaviour.

interface FakeIssue {
	id: string;
	identifier: string;
	title: string;
	description: string;
	state: string; // state name
	assignee?: string; // user id
	labels: string[]; // label names
	project?: string;
	comments: { id: string; body: string; createdAt: string; user: string }[];
	updatedAt: string;
}

export const USERS: Record<string, { id: string; name: string; email: string }> = {
	dan: { id: "u-dan", name: "Dan", email: "dan@example.test" },
	sam: { id: "u-sam", name: "Sam", email: "sam@example.test" },
};

const STATE_TYPES: Record<string, string> = {
	Backlog: "backlog",
	Ready: "unstarted",
	"In Progress": "started",
	"In Review": "started",
	Done: "completed",
	Canceled: "canceled",
};

export class FakeLinear {
	viewer = USERS.dan;
	team = { id: "team-eng", key: "ENG", name: "Engineering" };
	labels = ["blocked", "repo:acme-app", "repo:other-app"];
	projects: { id: string; name: string; url: string; description: string }[] = [];
	issues = new Map<string, FakeIssue>();
	relations: { blocker: string; blocked: string }[] = []; // issue ids
	// Convert list bullets the way a Markdown round-trip might, to prove parsing tolerates it.
	normaliseMarkdown = false;
	// Fail the next mutation whose query contains `match`. "lost" applies the write, then fails.
	failNext: { match: string; mode: "network" | "server" | "lost" } | undefined;
	requests: { query: string; variables: Record<string, any> }[] = [];
	private seq = 100;
	private clock = Date.parse("2026-10-01T09:00:00Z");

	private now(): string {
		this.clock += 60_000;
		return new Date(this.clock).toISOString();
	}

	add(identifier: string, patch: Partial<FakeIssue> = {}): FakeIssue {
		const issue: FakeIssue = {
			id: `id-${identifier}`,
			identifier,
			title: `Title of ${identifier}`,
			description: "Acceptance: it works.",
			state: "Ready",
			labels: [],
			comments: [],
			updatedAt: this.now(),
			...patch,
		};
		this.issues.set(identifier, issue);
		return issue;
	}

	get(identifier: string): FakeIssue {
		const issue = this.issues.get(identifier);
		if (!issue) throw new Error(`no fake issue ${identifier}`);
		return issue;
	}

	comment(identifier: string, body: string, user = this.viewer.id): void {
		this.get(identifier).comments.push({ id: `c-${++this.seq}`, body: this.md(body), createdAt: this.now(), user });
	}

	blocks(blocker: string, blocked: string): void {
		this.relations.push({ blocker: this.get(blocker).id, blocked: this.get(blocked).id });
	}

	private md(text: string): string {
		return this.normaliseMarkdown ? text.replace(/^- /gm, "* ").replace(/^---$/gm, "***") : text;
	}

	private byId(id: string): FakeIssue {
		const issue = [...this.issues.values()].find((i) => i.id === id || i.identifier === id);
		if (!issue) throw new GraphqlError("Entity not found: Issue");
		return issue;
	}

	private state(name: string) {
		return { id: `state-${name}`, name, type: STATE_TYPES[name] };
	}

	private user(id: string | undefined) {
		const user = Object.values(USERS).find((u) => u.id === id);
		return user ? { id: user.id, name: user.name } : null;
	}

	private ref(issue: FakeIssue) {
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			url: `https://linear.example/${issue.identifier}`,
			updatedAt: issue.updatedAt,
			description: issue.description,
			state: this.state(issue.state),
			assignee: this.user(issue.assignee),
			labels: { nodes: issue.labels.map((name) => ({ name })) },
			inverseRelations: {
				nodes: this.relations.filter((r) => r.blocked === issue.id).map((r) => ({ type: "blocks", issue: this.shallow(this.byId(r.blocker)) })),
			},
		};
	}

	private shallow(issue: FakeIssue) {
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			url: `https://linear.example/${issue.identifier}`,
			state: this.state(issue.state),
			assignee: this.user(issue.assignee),
			labels: { nodes: issue.labels.map((name) => ({ name })) },
		};
	}

	private matches(issue: FakeIssue, filter: Record<string, any> | undefined): boolean {
		if (!filter) return true;
		const text = (value: string, cmp: Record<string, string>) => {
			if (cmp.contains !== undefined) return value.includes(cmp.contains);
			if (cmp.containsIgnoreCase !== undefined) return value.toLowerCase().includes(cmp.containsIgnoreCase.toLowerCase());
			throw new GraphqlError(`fake: unsupported string comparator ${JSON.stringify(cmp)}`);
		};
		for (const [key, value] of Object.entries(filter)) {
			let ok: boolean;
			if (key === "team") ok = value.key.eq === this.team.key;
			else if (key === "state") {
				const type = STATE_TYPES[issue.state];
				// Like Linear, name filters are exact; ids are what the commands use.
				if (value.id?.eq !== undefined) ok = `state-${issue.state}` === value.id.eq;
				else if (value.id?.in) ok = value.id.in.includes(`state-${issue.state}`);
				else if (value.name?.eq !== undefined) ok = issue.state === value.name.eq;
				else if (value.name?.in) ok = value.name.in.includes(issue.state);
				else if (value.type?.eq !== undefined) ok = type === value.type.eq;
				else if (value.type?.nin) ok = !value.type.nin.includes(type);
				else throw new GraphqlError(`fake: unsupported state filter ${JSON.stringify(value)}`);
			} else if (key === "assignee") {
				if (value.isMe) ok = (issue.assignee === this.viewer.id) === value.isMe.eq;
				else if (value.null !== undefined) ok = (issue.assignee === undefined) === value.null;
				else throw new GraphqlError(`fake: unsupported assignee filter ${JSON.stringify(value)}`);
			} else if (key === "labels") ok = issue.labels.includes(value.some.name.eq);
			else if (key === "or") ok = (value as Record<string, any>[]).some((f) => this.matches(issue, f));
			else if (key === "and") ok = (value as Record<string, any>[]).every((f) => this.matches(issue, f));
			else if (key === "title") ok = text(issue.title, value);
			else if (key === "description") ok = text(issue.description, value);
			else throw new GraphqlError(`fake: unsupported filter ${key}`);
			if (!ok) return false;
		}
		return true;
	}

	// Cursor pagination: the cursor is the index of the next item.
	private page<T>(items: T[], first: number, after: string | null | undefined) {
		const start = after ? Number(after) : 0;
		const end = start + first;
		return { nodes: items.slice(start, end), pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null } };
	}

	handle(query: string, variables: Record<string, any>): unknown {
		this.requests.push({ query, variables });
		if (query.trimStart().startsWith("mutation")) {
			const failure = this.failNext && query.includes(this.failNext.match) ? this.failNext : undefined;
			if (failure) {
				this.failNext = undefined;
				if (failure.mode === "lost") this.mutate(query, variables);
				throw new TransportError(failure.mode === "server" ? 502 : 0);
			}
			return this.mutate(query, variables);
		}
		if (query.includes("viewer {")) return { viewer: this.viewer };
		if (query.includes("teams(")) return { teams: { nodes: variables.key === this.team.key ? [this.team] : [] } };
		if (query.includes("workflowStates(")) return { workflowStates: { nodes: Object.keys(STATE_TYPES).map((n) => this.state(n)) } };
		if (query.includes("projects(")) {
			return { projects: { nodes: this.projects.filter((p) => p.name.toLowerCase() === String(variables.name).toLowerCase()) } };
		}
		if (query.includes("issueLabels(")) {
			const name = this.labels.find((l) => l.toLowerCase() === String(variables.name).toLowerCase());
			return { issueLabels: { nodes: name ? [{ id: `label-${name}`, team: null }] : [] } };
		}
		if (query.includes("issues(")) {
			const page = this.page([...this.issues.values()].filter((i) => this.matches(i, variables.filter)), variables.first ?? 50, variables.after);
			return { issues: { nodes: page.nodes.map((i) => this.ref(i)), pageInfo: page.pageInfo } };
		}
		if (query.includes("issue(id: $id)")) {
			const issue = this.byId(variables.id);
			const first = Number(/comments\(first: (\d+)/.exec(query)?.[1] ?? 50);
			const page = this.page(issue.comments, first, variables.after);
			const comments = { nodes: page.nodes.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, user: this.user(c.user) })), pageInfo: page.pageInfo };
			if (!query.includes("attachments")) return { issue: { comments } };
			return {
				issue: {
					...this.ref(issue),
					team: { id: this.team.id, key: this.team.key },
					project: issue.project ? { id: `project-${issue.project}`, name: issue.project } : null,
					relations: {
						nodes: this.relations.filter((r) => r.blocker === issue.id).map((r) => ({ type: "blocks", relatedIssue: this.shallow(this.byId(r.blocked)) })),
					},
					comments,
					attachments: { nodes: [] },
				},
			};
		}
		throw new GraphqlError(`fake: unrecognised query ${query.slice(0, 80)}`);
	}

	private mutate(query: string, variables: Record<string, any>): unknown {
		if (query.includes("projectCreate")) {
			const name = variables.input.name;
			const project = { id: `project-${name}`, name, url: `https://linear.example/project/${encodeURIComponent(name)}`, description: variables.input.description };
			this.projects.push(project);
			return { projectCreate: { success: true, project: { id: project.id, name, url: project.url } } };
		}
		if (query.includes("issueCreate")) {
			const input = variables.input;
			const identifier = `ENG-${++this.seq}`;
			const stateName = Object.keys(STATE_TYPES).find((n) => `state-${n}` === input.stateId) ?? "Backlog";
			const issue = this.add(identifier, {
				title: input.title,
				description: this.md(input.description),
				state: stateName,
				labels: (input.labelIds ?? []).map((id: string) => id.replace(/^label-/, "")),
				project: input.projectId?.replace(/^project-/, ""),
			});
			return { issueCreate: { success: true, issue: { id: issue.id, identifier, url: `https://linear.example/${identifier}` } } };
		}
		if (query.includes("issueRelationCreate")) {
			this.relations.push({ blocker: variables.input.issueId, blocked: variables.input.relatedIssueId });
			return { issueRelationCreate: { success: true } };
		}
		if (query.includes("commentCreate")) {
			const issue = this.byId(variables.input.issueId);
			const id = `c-${++this.seq}`;
			issue.comments.push({ id, body: this.md(variables.input.body), createdAt: this.now(), user: this.viewer.id });
			return { commentCreate: { success: true, comment: { id } } };
		}
		if (query.includes("issueUpdate")) {
			const issue = this.byId(variables.id);
			const input = variables.input;
			if (input.stateId) issue.state = input.stateId.replace(/^state-/, "");
			if (input.assigneeId) issue.assignee = input.assigneeId;
			for (const id of input.addedLabelIds ?? []) issue.labels.push(id.replace(/^label-/, ""));
			for (const id of input.removedLabelIds ?? []) issue.labels = issue.labels.filter((l) => `label-${l}` !== id);
			issue.updatedAt = this.now();
			return { issueUpdate: { success: true } };
		}
		throw new GraphqlError(`fake: unrecognised mutation ${query.slice(0, 80)}`);
	}

	// In-process transport for unit tests.
	fetch: FetchLike = async (_url, init) => {
		const { query, variables } = JSON.parse(init.body);
		try {
			const data = this.handle(query, variables ?? {});
			return { ok: true, status: 200, json: async () => ({ data }), text: async () => "" };
		} catch (error) {
			if (error instanceof GraphqlError) return { ok: true, status: 200, json: async () => ({ errors: [{ message: error.message }] }), text: async () => "" };
			if (error instanceof TransportError && error.status) return { ok: false, status: error.status, json: async () => ({}), text: async () => "bad gateway" };
			throw new Error("socket hang up");
		}
	};

	// HTTP transport for end-to-end tests against a real Pi process.
	async listen(): Promise<{ url: string; close: () => Promise<void> }> {
		const server: Server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				if (req.headers.authorization !== "test-key") {
					res.writeHead(401).end("unauthorised");
					return;
				}
				try {
					const { query, variables } = JSON.parse(body);
					const data = this.handle(query, variables ?? {});
					res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data }));
				} catch (error) {
					if (error instanceof GraphqlError) {
						res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ errors: [{ message: error.message }] }));
					} else if (error instanceof TransportError && error.status) {
						res.writeHead(error.status).end("bad gateway");
					} else {
						req.socket.destroy();
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		return { url: `http://127.0.0.1:${port}/graphql`, close: () => new Promise((resolve) => server.close(() => resolve())) };
	}
}

class GraphqlError extends Error {}
class TransportError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`transport ${status}`);
		this.status = status;
	}
}
