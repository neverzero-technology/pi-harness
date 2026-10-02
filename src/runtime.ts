import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Checkpoint } from "./checkpoint.ts";
import { containsCheckpoint, formatCheckpoint, newCheckpointId } from "./checkpoint.ts";
import type { LogicalState, TeamConfig } from "./config.ts";
import { loadTeamConfig, PACKAGE_ROOT } from "./config.ts";
import { type LoadedProfile, loadProfile, type Profile } from "./profile.ts";
import { branchIssue, Git, GitHub, type WorkingState } from "./git.ts";
import type { Issue, WorkflowState } from "./linear.ts";
import { LinearClient, LinearError } from "./linear.ts";
import { parseMetadata } from "./metadata.ts";
import type { Mode } from "./modes.ts";
import type { SandboxHandle } from "./sandbox.ts";
import { PendingStore, ReviewStore } from "./pending.ts";
import { DiscoverStore } from "./discover.ts";

export const STATE_ENTRY = "pi-team-state";
export const MESSAGE_TYPE = "pi-team";

export interface SessionState {
	issue?: string;
	mode: Mode;
}

export interface RepoContext {
	git: Git;
	gh: GitHub;
	root: string;
	origin: string | undefined;
	// The repository's own .pi-team/profile.json; undefined until the repository has adopted the workflow.
	profile: Profile | undefined;
	profileState: LoadedProfile;
	defaultRef: string;
	pending: PendingStore;
	reviews: ReviewStore;
	discover: DiscoverStore;
}

export class TeamError extends Error {}

export interface Viewer {
	id: string;
	name: string;
	email: string;
}

export class Team {
	sandbox: SandboxHandle | undefined;
	readonly config: TeamConfig;
	state: SessionState = { mode: "implement" };
	repo: RepoContext | undefined;
	// HEAD at the last checkpoint this session stored; used to warn before context is compacted.
	checkpointedHead: string | undefined;
	// Set by /work finish: the commit a final checkpoint for that issue is recorded against.
	assessing: { issue: string; commit: string; branch: string | undefined } | undefined;
	private linearClient: LinearClient | undefined;
	private viewerCache: Promise<Viewer> | undefined;
	private readonly stateCache = new Map<string, Promise<WorkflowState[]>>();

	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.config = loadTeamConfig();
	}

	resource(...parts: string[]): string {
		return join(PACKAGE_ROOT, ...parts);
	}

	async loadRepo(cwd: string): Promise<RepoContext | undefined> {
		const exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
			this.pi.exec(command, args, { cwd: options?.cwd ?? cwd, timeout: options?.timeout });
		const git = new Git(exec, cwd);
		const root = await git.root();
		if (!root) {
			this.repo = undefined;
			return undefined;
		}
		const rootGit = new Git(exec, root);
		const origin = await rootGit.origin();
		const detected = `origin/${await rootGit.defaultBranch()}`;
		const profileState = await loadProfile(rootGit, root, detected);
		const profile = profileState.profile;
		const commonDir = (await git.commonDir()) ?? join(root, ".git");
		this.repo = {
			git: rootGit,
			gh: new GitHub(exec, root),
			root,
			origin,
			profile,
			profileState,
			defaultRef: profile?.defaultBranch ? `origin/${profile.defaultBranch}` : detected,
			pending: new PendingStore(commonDir),
			reviews: new ReviewStore(commonDir),
			discover: new DiscoverStore(commonDir),
		};
		return this.repo;
	}

	async requireRepo(ctx: ExtensionContext): Promise<RepoContext> {
		const repo = this.repo ?? (await this.loadRepo(ctx.cwd));
		if (!repo) throw new TeamError("Not inside a git repository");
		return repo;
	}

	linearKeySource(): { key: string; source: string } | undefined {
		if (process.env.LINEAR_API_KEY) return { key: process.env.LINEAR_API_KEY.trim(), source: "LINEAR_API_KEY" };
		const file = join(homedir(), ".config", "pi-team", "linear-api-key");
		if (existsSync(file)) {
			const key = readFileSync(file, "utf8").trim();
			if (key) return { key, source: file };
		}
		return undefined;
	}

	linear(): LinearClient {
		if (this.linearClient) return this.linearClient;
		const found = this.linearKeySource();
		if (!found) {
			throw new TeamError(
				"No Linear API key. Create a personal key in Linear (Settings → Security & access) and export LINEAR_API_KEY, or save it to ~/.config/pi-team/linear-api-key (chmod 600).",
			);
		}
		this.linearClient = new LinearClient(found.key);
		return this.linearClient;
	}

	// Identity and workflow states do not change within a session; failed lookups are not cached.
	viewer(): Promise<Viewer> {
		this.viewerCache ??= this.linear()
			.viewer()
			.catch((error) => {
				this.viewerCache = undefined;
				throw error;
			});
		return this.viewerCache;
	}

	async stateId(teamKey: string, logical: LogicalState): Promise<string> {
		const name = this.config.linear.states[logical];
		if (!this.stateCache.has(teamKey)) {
			this.stateCache.set(
				teamKey,
				this.linear()
					.workflowStates(teamKey)
					.catch((error) => {
						this.stateCache.delete(teamKey);
						throw error;
					}),
			);
		}
		const states = await this.stateCache.get(teamKey)!;
		const state = states.find((s) => s.name.toLowerCase() === name.toLowerCase());
		if (!state) throw new TeamError(`Linear team ${teamKey} has no workflow state named "${name}" (team.json linear.states.${logical})`);
		return state.id;
	}

	isState(issue: { state: { name: string } }, logical: LogicalState): boolean {
		return issue.state.name.toLowerCase() === this.config.linear.states[logical].toLowerCase();
	}

	issueKeyFrom(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const match = new RegExp(`\\b(${this.config.linear.teamKey}-\\d+)\\b`, "i").exec(text);
		return match?.[1].toUpperCase();
	}

	// An explicit argument must name an issue; it never falls back silently to the session's issue.
	async resolveIssueKey(arg: string | undefined, ctx: ExtensionContext): Promise<string> {
		const text = arg?.trim();
		if (text) {
			const fromArg = this.issueKeyFrom(text);
			if (!fromArg) throw new TeamError(`"${text}" is not a ${this.config.linear.teamKey} issue key (expected ${this.config.linear.teamKey}-123)`);
			return fromArg;
		}
		if (this.state.issue) return this.state.issue;
		const repo = await this.requireRepo(ctx);
		const branch = await repo.git.run(["branch", "--show-current"]);
		const fromBranch = this.issueKeyFrom(branch);
		if (fromBranch) return fromBranch;
		throw new TeamError(`Name an issue, e.g. ${this.config.linear.teamKey}-123`);
	}

	async requireIssue(key: string): Promise<Issue> {
		const issue = await this.linear().issue(key);
		if (!issue) throw new TeamError(`Linear issue ${key} not found`);
		return issue;
	}

	setState(patch: Partial<SessionState>, ctx: ExtensionContext): void {
		const previous = this.state.mode;
		this.state = { ...this.state, ...patch };
		this.pi.appendEntry(STATE_ENTRY, this.state);
		if (this.state.mode !== previous) {
			// Requirements work and review get deeper reasoning than ordinary implementation.
			const level = this.state.mode === "implement" ? this.config.model.thinking : this.config.model.reviewThinking;
			this.pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		}
		this.showStatus(ctx);
	}

	restoreState(ctx: ExtensionContext): void {
		this.state = { mode: "implement" };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
				this.state = { ...(entry.data as SessionState) };
			}
		}
		// A session resumed in spec or review mode gets that mode's reasoning level back too.
		if (this.state.mode !== "implement") this.pi.setThinkingLevel(this.config.model.reviewThinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	}

	showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const parts = [this.state.issue ?? "no issue", this.state.mode];
		if (this.repo?.profile) parts.unshift(this.repo.profile.name);
		ctx.ui.setStatus("pi-team", parts.join(" · "));
	}

	report(text: string, details?: unknown): void {
		this.pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true, details }, { triggerTurn: false });
	}

	ask(prompt: string, ctx: ExtensionContext): void {
		if (ctx.isIdle()) this.pi.sendUserMessage(prompt);
		else this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	unsyncedState(git: WorkingState): string[] {
		const out: string[] = [];
		if (git.changed.length) out.push(`${git.changed.length} uncommitted file(s)`);
		if (git.untracked.length) out.push(`${git.untracked.length} untracked file(s)`);
		if (!git.upstream) out.push("branch not pushed");
		else if (git.unpushed) out.push(`${git.unpushed} unpushed commit(s)`);
		return out;
	}

	// Post a checkpoint. A failed or uncertain post leaves one local pending file that resume surfaces.
	async postCheckpoint(
		issue: Issue,
		fields: Pick<Checkpoint, "kind" | "done" | "remaining" | "checks" | "blocker" | "next">,
		ctx: ExtensionContext,
		checkout?: Git, // the worktree the work happens in, when it is not this session's checkout
	): Promise<{ synced: boolean; id: string; message: string }> {
		const repo = await this.requireRepo(ctx);
		const linear = this.linear();
		const git = await (checkout ?? repo.git).state();
		if (!git) throw new TeamError("Not inside a git repository");
		const viewer = await this.viewer();
		if (issue.assignee?.id !== viewer.id) {
			throw new TeamError(
				issue.assignee
					? `${issue.identifier} is owned by ${issue.assignee.name}; checkpoints record the owner's progress. Comment in Linear instead, or have it reassigned.`
					: `${issue.identifier} is unassigned; take it with /work start before recording progress.`,
			);
		}
		// A checkout on another issue's branch would stamp this issue with that issue's branch and commit.
		const assessing = fields.kind === "final" && this.assessing?.issue === issue.identifier ? this.assessing : undefined;
		const branchOwner = branchIssue(git.branch, this.config.linear.teamKey);
		if (branchOwner && branchOwner !== issue.identifier) {
			throw new TeamError(`This checkout is on ${git.branch}, which belongs to ${branchOwner}; switch to ${issue.identifier}'s branch or name the right issue.`);
		}
		const meta = parseMetadata(issue.description);
		const branch = assessing?.branch ?? git.branch;
		const pr = branch ? await repo.gh.prForBranch(branch) : undefined;
		const notes: string[] = [];

		const previous = repo.pending.get(issue.identifier);
		if (previous) {
			const comments = await linear.comments(issue.identifier).catch(() => undefined);
			if (comments && containsCheckpoint(comments, previous.id)) notes.push(`Earlier checkpoint ${previous.id} had in fact been stored.`);
			else notes.push(`Earlier unsynced checkpoint ${previous.id} is superseded by this one.`);
		}

		const dirty = git.changed.length + git.untracked.length > 0;
		const checkpoint: Checkpoint = {
			id: newCheckpointId(),
			kind: fields.kind,
			issue: issue.identifier,
			owner: viewer.name,
			spec: meta.spec
				? `${meta.specRepo ? `${meta.specRepo}:` : ""}${meta.spec}${meta.specCommit ? `@${meta.specCommit}` : ""}`
				: "direct acceptance in the issue",
			branch,
			commit: assessing?.commit ?? git.head,
			pr: pr ? `#${pr.number} (${pr.state.toLowerCase()}${pr.isDraft ? ", draft" : ""})` : undefined,
			done: fields.done,
			remaining: fields.remaining,
			checks: fields.checks.map((c) => ({ ...c, commit: c.commit ?? git.head, dirty })),
			blocker: fields.blocker,
			next: fields.next,
			unsynced: this.unsyncedState(git),
		};
		const body = formatCheckpoint(checkpoint);
		const pending = {
			id: checkpoint.id,
			issue: issue.identifier,
			body,
			createdAt: new Date().toISOString(),
			error: "",
			uncertain: false,
		};
		repo.pending.put(pending);
		try {
			await linear.comment(issue.id, body);
			repo.pending.clear(issue.identifier);
			if (!checkout) this.checkpointedHead = dirty ? undefined : git.head;
			if (ctx.hasUI) ctx.ui.setStatus("pi-team-sync", undefined);
			this.showStatus(ctx);
			return { synced: true, id: checkpoint.id, message: [`Checkpoint ${checkpoint.id} stored on ${issue.identifier}.`, ...notes].join(" ") };
		} catch (error) {
			const uncertain = error instanceof LinearError && error.uncertain;
			repo.pending.put({ ...pending, error: (error as Error).message, uncertain });
			if (ctx.hasUI) ctx.ui.setStatus("pi-team-sync", `checkpoint ${checkpoint.id} NOT synced`);
			return {
				synced: false,
				id: checkpoint.id,
				message: [
					`Shared progress is NOT confirmed: ${(error as Error).message}.`,
					uncertain ? "The comment may or may not have been stored; /work resume checks before retrying." : "The comment was not stored.",
					`Saved locally as pending checkpoint ${checkpoint.id}.`,
					...notes,
				].join(" "),
			};
		}
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
