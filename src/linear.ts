import type { CommentLike } from "./checkpoint.ts";

// Direct Linear GraphQL client. One small, reviewed write path instead of an MCP tool surface.

export const LINEAR_URL = "https://api.linear.app/graphql";

// Tests point the client at a local fake. Only loopback is honoured, so the key can never be sent elsewhere.
export function linearUrl(override = process.env.PI_TEAM_LINEAR_URL): string {
	if (!override) return LINEAR_URL;
	try {
		const url = new URL(override);
		if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return override;
	} catch {
		// fall through
	}
	return LINEAR_URL;
}

export class LinearError extends Error {
	// True when the request may have been applied (a mutation that failed in transit or with a 5xx).
	readonly uncertain: boolean;
	readonly kind: "network" | "http" | "graphql";
	constructor(message: string, uncertain: boolean, kind: "network" | "http" | "graphql") {
		super(message);
		this.name = "LinearError";
		this.uncertain = uncertain;
		this.kind = kind;
	}
}

export interface WorkflowState {
	id: string;
	name: string;
	type: string; // triage | backlog | unstarted | started | completed | canceled
}

export interface IssueRef {
	id: string;
	identifier: string;
	title: string;
	url: string;
	state: WorkflowState;
	assignee?: { id: string; name: string };
	labels: string[];
	description?: string;
	updatedAt?: string;
	openBlockers?: string[]; // only populated by issues()
}

export interface Issue extends IssueRef {
	description: string;
	team: { id: string; key: string };
	project?: { id: string; name: string };
	blockers: IssueRef[];
	blocks: IssueRef[];
	comments: CommentLike[];
	attachments: { url: string; title: string }[];
}

// `more` is true when Linear holds further matches beyond the limit asked for.
export type IssueList = IssueRef[] & { more: boolean };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

// Linear rejects queries above a complexity budget, and every connection multiplies by its page size.
// Pages stay small and nested connections are bounded so list queries remain well inside it.
const PAGE = 50;
const REF_FIELDS = `id identifier title url updatedAt state { id name type } assignee { id name } labels(first: 20) { nodes { name } }`;
const LIST_FIELDS = `${REF_FIELDS} description inverseRelations(first: 10) { nodes { type issue { identifier state { type } } } }`;
const COMMENT_PAGE = `nodes { id body createdAt user { name } } pageInfo { hasNextPage endCursor }`;

interface RawRef {
	id: string;
	identifier: string;
	title: string;
	url: string;
	updatedAt?: string;
	description?: string;
	state: WorkflowState;
	assignee: { id: string; name: string } | null;
	labels: { nodes: { name: string }[] };
	inverseRelations?: { nodes: { type: string; issue: { identifier: string; state: { type: string } } }[] };
}

interface RawComments {
	nodes: { id: string; body: string; createdAt: string; user: { name: string } | null }[];
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function toRef(raw: RawRef): IssueRef {
	const openBlockers = raw.inverseRelations?.nodes
		.filter((r) => r.type === "blocks" && r.issue.state.type !== "completed" && r.issue.state.type !== "canceled")
		.map((r) => r.issue.identifier);
	return {
		openBlockers,
		id: raw.id,
		identifier: raw.identifier,
		title: raw.title,
		url: raw.url,
		updatedAt: raw.updatedAt,
		description: raw.description,
		state: raw.state,
		assignee: raw.assignee ?? undefined,
		labels: raw.labels.nodes.map((l) => l.name),
	};
}

const toComments = (raw: RawComments): CommentLike[] =>
	raw.nodes.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: c.user?.name }));

export class LinearClient {
	private readonly apiKey: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;

	constructor(apiKey: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike, timeoutMs = 20_000) {
		this.apiKey = apiKey;
		this.fetchImpl = fetchImpl;
		this.timeoutMs = timeoutMs;
	}

	async request<T>(query: string, variables: Record<string, unknown> = {}, mutation = false): Promise<T> {
		const controller = new AbortController();
		// The timer covers reading the body too, so a stalled response cannot hang the session.
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			let response: Awaited<ReturnType<FetchLike>>;
			try {
				response = await this.fetchImpl(linearUrl(), {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: this.apiKey },
					body: JSON.stringify({ query, variables }),
					signal: controller.signal,
				});
			} catch (error) {
				throw new LinearError(`Linear request failed: ${(error as Error).message}`, mutation, "network");
			}
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new LinearError(`Linear HTTP ${response.status}: ${body.slice(0, 300)}`, mutation && response.status >= 500, "http");
			}
			let payload: { data?: T; errors?: { message: string }[] };
			try {
				payload = (await response.json()) as typeof payload;
			} catch (error) {
				// The request reached Linear and was answered, but the answer is unreadable: a write may have landed.
				throw new LinearError(`Linear response unreadable: ${(error as Error).message}`, mutation, "network");
			}
			if (payload.errors?.length) {
				throw new LinearError(`Linear: ${payload.errors.map((e) => e.message).join("; ")}`, false, "graphql");
			}
			if (!payload.data) throw new LinearError("Linear returned no data", mutation, "network");
			return payload.data;
		} finally {
			clearTimeout(timer);
		}
	}

	async viewer(): Promise<{ id: string; name: string; email: string }> {
		const data = await this.request<{ viewer: { id: string; name: string; email: string } }>(
			`query { viewer { id name email } }`,
		);
		return data.viewer;
	}

	async team(key: string): Promise<{ id: string; key: string; name: string } | undefined> {
		const data = await this.request<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(
			`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`,
			{ key },
		);
		return data.teams.nodes[0];
	}

	async workflowStates(teamKey: string): Promise<WorkflowState[]> {
		const data = await this.request<{ workflowStates: { nodes: WorkflowState[] } }>(
			`query($key: String!) { workflowStates(filter: { team: { key: { eq: $key } } }, first: 100) { nodes { id name type } } }`,
			{ key: teamKey },
		);
		return data.workflowStates.nodes;
	}

	async labelId(name: string, teamId: string): Promise<string | undefined> {
		const data = await this.request<{ issueLabels: { nodes: { id: string; team: { id: string } | null }[] } }>(
			`query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 20) { nodes { id team { id } } } }`,
			{ name },
		);
		// Prefer a team label, fall back to a workspace label.
		const nodes = data.issueLabels.nodes;
		return (nodes.find((l) => l.team?.id === teamId) ?? nodes.find((l) => !l.team))?.id;
	}

	async issue(key: string): Promise<Issue | undefined> {
		let data: { issue: any };
		try {
			data = await this.request<{ issue: any }>(
				`query($id: String!) {
					issue(id: $id) {
						${REF_FIELDS} description
						team { id key } project { id name }
						inverseRelations(first: 25) { nodes { type issue { ${REF_FIELDS} } } }
						relations(first: 25) { nodes { type relatedIssue { ${REF_FIELDS} } } }
						comments(first: ${PAGE}) { ${COMMENT_PAGE} }
						attachments(first: 25) { nodes { url title } }
					}
				}`,
				{ id: key },
			);
		} catch (error) {
			// Only Linear saying the entity does not exist means "no such issue"; an HTTP 404 or outage does not.
			if (error instanceof LinearError && error.kind === "graphql" && /entity not found/i.test(error.message)) return undefined;
			throw error;
		}
		const raw = data.issue;
		if (!raw) return undefined;
		const { inverseRelations, relations, comments, ...rest } = raw;
		return {
			...toRef(rest as RawRef),
			description: raw.description ?? "",
			team: raw.team,
			project: raw.project ?? undefined,
			blockers: inverseRelations.nodes.filter((r: { type: string }) => r.type === "blocks").map((r: { issue: RawRef }) => toRef(r.issue)),
			blocks: relations.nodes.filter((r: { type: string }) => r.type === "blocks").map((r: { relatedIssue: RawRef }) => toRef(r.relatedIssue)),
			comments: [...toComments(comments), ...(comments.pageInfo.hasNextPage ? await this.commentsAfter(key, comments.pageInfo.endCursor) : [])],
			attachments: raw.attachments.nodes,
		};
	}

	// Every comment, however many pages: the latest checkpoint and recorded checks must never be cut off.
	private async commentsAfter(issueKey: string, cursor: string | null): Promise<CommentLike[]> {
		const all: CommentLike[] = [];
		let after = cursor;
		// 200 pages is 10,000 comments; the bound only exists so a misbehaving server cannot loop forever.
		for (let page = 0; page < 200; page++) {
			const data = await this.request<{ issue: { comments: RawComments } | null }>(
				`query($id: String!, $after: String) { issue(id: $id) { comments(first: ${PAGE}, after: $after) { ${COMMENT_PAGE} } } }`,
				{ id: issueKey, after },
			);
			const comments = data.issue?.comments;
			if (!comments) break;
			all.push(...toComments(comments));
			if (!comments.pageInfo.hasNextPage || !comments.nodes.length || comments.pageInfo.endCursor === after) break;
			after = comments.pageInfo.endCursor;
		}
		return all;
	}

	comments(issueKey: string): Promise<CommentLike[]> {
		return this.commentsAfter(issueKey, null);
	}

	async issues(filter: Record<string, unknown>, limit = 200): Promise<IssueList> {
		const all: IssueRef[] = [];
		let after: string | null = null;
		let more = false;
		while (all.length < limit) {
			const first = Math.min(PAGE, limit - all.length);
			const data: { issues: { nodes: RawRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.request(
				`query($filter: IssueFilter, $first: Int, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${LIST_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
				{ filter, first, after },
			);
			all.push(...data.issues.nodes.map(toRef));
			more = data.issues.pageInfo.hasNextPage;
			// An empty page or a cursor that does not advance would otherwise loop forever.
			if (!more || !data.issues.nodes.length || data.issues.pageInfo.endCursor === after) break;
			after = data.issues.pageInfo.endCursor;
		}
		return Object.assign(all, { more });
	}

	async project(name: string): Promise<{ id: string; name: string; url: string } | undefined> {
		const data = await this.request<{ projects: { nodes: { id: string; name: string; url: string }[] } }>(
			`query($name: String!) { projects(filter: { name: { eqIgnoreCase: $name } }, first: 5) { nodes { id name url } } }`,
			{ name },
		);
		return data.projects.nodes[0];
	}

	async createProject(input: { name: string; description: string; teamIds: string[] }): Promise<{ id: string; name: string; url: string }> {
		const data = await this.request<{ projectCreate: { success: boolean; project: { id: string; name: string; url: string } } }>(
			`mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name url } } }`,
			{ input },
			true,
		);
		if (!data.projectCreate.success) throw new LinearError("projectCreate reported failure", false, "graphql");
		return data.projectCreate.project;
	}

	async createIssue(input: {
		teamId: string;
		title: string;
		description: string;
		labelIds?: string[];
		projectId?: string;
		stateId?: string;
	}): Promise<{ id: string; identifier: string; url: string }> {
		const data = await this.request<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
			`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
			{ input },
			true,
		);
		if (!data.issueCreate.success) throw new LinearError("issueCreate reported failure", false, "graphql");
		return data.issueCreate.issue;
	}

	async createBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
		const data = await this.request<{ issueRelationCreate: { success: boolean } }>(
			`mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
			{ input: { issueId: blockerId, relatedIssueId: blockedId, type: "blocks" } },
			true,
		);
		if (!data.issueRelationCreate.success) throw new LinearError("issueRelationCreate reported failure", false, "graphql");
	}

	async comment(issueId: string, body: string): Promise<{ id: string }> {
		const data = await this.request<{ commentCreate: { success: boolean; comment: { id: string } } }>(
			`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
			{ input: { issueId, body } },
			true,
		);
		if (!data.commentCreate.success) throw new LinearError("commentCreate reported failure", false, "graphql");
		return data.commentCreate.comment;
	}

	async updateIssue(
		id: string,
		input: { stateId?: string; assigneeId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] },
	): Promise<void> {
		const data = await this.request<{ issueUpdate: { success: boolean } }>(
			`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
			{ id, input },
			true,
		);
		if (!data.issueUpdate.success) throw new LinearError("issueUpdate reported failure", false, "graphql");
	}
}

export function isOpen(ref: IssueRef): boolean {
	return ref.state.type !== "completed" && ref.state.type !== "canceled";
}
