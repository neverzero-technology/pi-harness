import { isAbsolute, resolve } from "node:path";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export interface WorkingState {
	root: string;
	branch: string | undefined;
	head: string | undefined;
	changed: string[];
	untracked: string[];
	upstream: string | undefined;
	unpushed: number | undefined;
}

export interface PullRequest {
	number: number;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	reviewDecision: string | null;
	mergedAt: string | null;
	author?: { login: string };
	latestReviews?: Array<{ author?: { login: string }; state: string }>;
	statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
}

// Approved by a person other than the PR author, with no outstanding change request.
// `reviewDecision` is only populated when branch protection requires reviews, so fall back to the reviews themselves.
export function humanReview(pr: PullRequest): { approved: boolean; detail: string } {
	const others = (pr.latestReviews ?? []).filter((r) => r.author?.login && r.author.login !== pr.author?.login);
	const changes = others.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author!.login);
	const approvals = others.filter((r) => r.state === "APPROVED").map((r) => r.author!.login);
	if (pr.reviewDecision === "CHANGES_REQUESTED" || changes.length) {
		return { approved: false, detail: `Changes requested${changes.length ? ` by ${changes.join(", ")}` : ""}` };
	}
	if (pr.reviewDecision === "REVIEW_REQUIRED") return { approved: false, detail: "Required review still outstanding" };
	if (pr.reviewDecision === "APPROVED" || approvals.length) {
		return { approved: true, detail: `Approved${approvals.length ? ` by ${approvals.join(", ")}` : ""}` };
	}
	return { approved: false, detail: "No approval from another person" };
}

// The harness runs git on the host, against a repository the sandboxed agent can write to. Hooks and the
// fsmonitor command are code from that repository, so host-side git never runs them. (Other config-driven
// commands, such as filters or a custom ssh command, are not covered.)
const HOST_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export class Git {
	private readonly exec: Exec;
	readonly cwd: string;

	constructor(exec: Exec, cwd: string) {
		this.exec = exec;
		this.cwd = cwd;
	}

	at(cwd: string): Git {
		return new Git(this.exec, cwd);
	}

	// The worktree that has `branch` checked out, if any other than this one.
	async worktreeFor(branch: string): Promise<string | undefined> {
		const out = (await this.run(["worktree", "list", "--porcelain"])) ?? "";
		for (const block of out.split("\n\n")) {
			const dir = /^worktree (.+)$/m.exec(block)?.[1];
			if (dir && new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(block)) return dir;
		}
		return undefined;
	}

	async run(args: string[], timeout = 30_000): Promise<string | undefined> {
		const result = await this.exec("git", [...HOST_SAFE, ...args], { cwd: this.cwd, timeout });
		return result.code === 0 ? result.stdout.trimEnd() : undefined;
	}

	async ok(args: string[]): Promise<boolean> {
		return (await this.exec("git", [...HOST_SAFE, ...args], { cwd: this.cwd, timeout: 30_000 })).code === 0;
	}

	root(): Promise<string | undefined> {
		return this.run(["rev-parse", "--show-toplevel"]);
	}

	async commonDir(): Promise<string | undefined> {
		const dir = await this.run(["rev-parse", "--git-common-dir"]);
		return dir && !isAbsolute(dir) ? resolve(this.cwd, dir) : dir;
	}


	origin(): Promise<string | undefined> {
		return this.run(["config", "--get", "remote.origin.url"]);
	}

	// origin's default branch: what origin/HEAD points at, else whichever of main or master exists there.
	async defaultBranch(): Promise<string> {
		const head = await this.run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
		if (head?.startsWith("origin/")) return head.slice("origin/".length);
		for (const name of ["main", "master"]) {
			if (await this.ok(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])) return name;
		}
		return "main";
	}

	trackedFiles(): Promise<string[]> {
		return this.run(["ls-files"], 60_000).then((out) => (out ? out.split("\n").filter(Boolean) : []));
	}

	async state(): Promise<WorkingState | undefined> {
		const root = await this.root();
		if (!root) return undefined;
		const branch = (await this.run(["branch", "--show-current"])) || undefined;
		const head = await this.run(["rev-parse", "HEAD"]);
		const porcelain = (await this.run(["status", "--porcelain=v1", "--untracked-files=all"])) ?? "";
		const changed: string[] = [];
		const untracked: string[] = [];
		for (const line of porcelain.split("\n").filter(Boolean)) {
			const file = line.slice(3).split(" -> ").pop() ?? "";
			if (line.startsWith("??")) untracked.push(file);
			else changed.push(file);
		}
		// The branch's counterpart on origin, whether or not tracking is configured (a plain `git push origin HEAD` sets none).
		// A configured upstream that is a different branch, such as origin/main, does not make this branch "pushed".
		const sameName = branch ? `origin/${branch}` : undefined;
		const configured = await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		const upstream =
			configured && configured === sameName
				? configured
				: sameName && (await this.ok(["rev-parse", "--verify", "--quiet", `refs/remotes/${sameName}`]))
					? sameName
					: undefined;
		const count = upstream ? await this.run(["rev-list", "--count", `${upstream}..HEAD`]) : undefined;
		return { root, branch, head, changed, untracked, upstream, unpushed: count ? Number(count) : undefined };
	}

	async fetch(remote: string, ref: string): Promise<boolean> {
		return (await this.exec("git", [...HOST_SAFE, "fetch", "--quiet", remote, ref], { cwd: this.cwd, timeout: 60_000 })).code === 0;
	}

	// Local and origin branches that belong to the issue: the first issue key in the name must be this one,
	// so ENG-1 does not match ENG-12, and "ENG-20-follow-up-to-eng-12" belongs to ENG-20.
	async branchesFor(issueKey: string): Promise<string[]> {
		const refs = (await this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"])) ?? "";
		return refs.split("\n").filter((ref) => {
			if (!ref || ref === "origin" || ref.endsWith("/HEAD")) return false;
			const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
			return branchIssue(name, issueKey.split("-")[0]) === issueKey.toUpperCase();
		});
	}

	async commitExists(sha: string): Promise<boolean> {
		return this.ok(["cat-file", "-e", `${sha}^{commit}`]);
	}

	async isAncestor(commit: string, ref: string): Promise<boolean> {
		return this.ok(["merge-base", "--is-ancestor", commit, ref]);
	}

	async lastCommitTouching(path: string, ref = "HEAD"): Promise<string | undefined> {
		return (await this.run(["log", "-1", "--format=%H", ref, "--", path])) || undefined;
	}

	// Commits on `ref` after `since` that touched `path`, newest first.
	async changesSince(path: string, since: string, ref: string): Promise<string[]> {
		const out = await this.run(["log", "--format=%h %s", `${since}..${ref}`, "--", path]);
		return out ? out.split("\n").filter(Boolean) : [];
	}

	async mergeBase(ref: string): Promise<string | undefined> {
		return this.run(["merge-base", "HEAD", ref]);
	}

	async diff(base: string, maxBytes: number): Promise<{ text: string; truncated: boolean; stat: string }> {
		const text = (await this.run(["diff", "--no-color", base], 60_000)) ?? "";
		const stat = (await this.run(["diff", "--stat", base])) ?? "";
		const truncated = Buffer.byteLength(text) > maxBytes;
		return { text: truncated ? Buffer.from(text).subarray(0, maxBytes).toString("utf8") : text, truncated, stat };
	}

	async changedFiles(base: string): Promise<string[]> {
		const out = await this.run(["diff", "--name-only", base]);
		return out ? out.split("\n").filter(Boolean) : [];
	}

	// Files added, changed, renamed or deleted on this branch since it left `base`.
	async nameStatus(base: string): Promise<string> {
		return (await this.run(["diff", "--name-status", "-M", `${base}...HEAD`], 60_000)) ?? "";
	}

	show(ref: string, path: string): Promise<string | undefined> {
		return this.run(["show", `${ref}:${path}`]);
	}

	// A new branch tracks its start point only when that is its own remote counterpart. Tracking the
	// default branch would make an unpushed branch look pushed and send a plain `git push` to main.
	private track(branch: string, startPoint: string): string {
		return startPoint === `origin/${branch}` ? "--track" : "--no-track";
	}

	// A plain push of one branch to its own name on origin. Never forced.
	push(branch: string): Promise<ExecResult> {
		return this.exec("git", [...HOST_SAFE, "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd: this.cwd, timeout: 120_000 });
	}

	async aheadOf(ref: string): Promise<number | undefined> {
		const count = await this.run(["rev-list", "--count", `${ref}..HEAD`]);
		return count === undefined ? undefined : Number(count);
	}

	async addWorktree(path: string, branch: string, startPoint: string, existing: boolean): Promise<ExecResult> {
		const args = existing ? ["worktree", "add", path, branch] : ["worktree", "add", this.track(branch, startPoint), "-b", branch, path, startPoint];
		return this.exec("git", [...HOST_SAFE, ...args], { cwd: this.cwd, timeout: 60_000 });
	}

	async switchTo(branch: string, startPoint: string, existing: boolean): Promise<ExecResult> {
		const args = existing ? ["switch", branch] : ["switch", this.track(branch, startPoint), "-c", branch, startPoint];
		return this.exec("git", [...HOST_SAFE, ...args], { cwd: this.cwd, timeout: 60_000 });
	}
}

export class GitHub {
	private readonly exec: Exec;
	private readonly cwd: string;
	lastError: string | undefined;

	constructor(exec: Exec, cwd: string) {
		this.exec = exec;
		this.cwd = cwd;
	}

	async authenticated(): Promise<boolean> {
		return (await this.exec("gh", ["auth", "status"], { cwd: this.cwd, timeout: 15_000 })).code === 0;
	}

	async prForBranch(branch: string): Promise<PullRequest | undefined> {
		const fields = "number,url,state,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,mergedAt";
		const result = await this.exec(
			"gh",
			["pr", "list", "--head", branch, "--state", "all", "--json", fields, "--limit", "20"],
			{ cwd: this.cwd, timeout: 30_000 },
		);
		this.lastError = result.code === 0 ? undefined : result.stderr.trim().split("\n")[0] || `gh exited ${result.code}`;
		if (result.code !== 0) return undefined;
		// A branch can have an abandoned PR and a live one: prefer open, then merged, then closed.
		const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 };
		return (JSON.parse(result.stdout || "[]") as PullRequest[]).sort((a, b) => rank[a.state] - rank[b.state])[0];
	}

	async prDetail(number: number): Promise<PullRequest | undefined> {
		const fields =
			"number,url,state,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,mergedAt,author,latestReviews,statusCheckRollup";
		const result = await this.exec("gh", ["pr", "view", String(number), "--json", fields], {
			cwd: this.cwd,
			timeout: 30_000,
		});
		this.lastError = result.code === 0 ? undefined : result.stderr.trim().split("\n")[0] || `gh exited ${result.code}`;
		return result.code === 0 ? (JSON.parse(result.stdout) as PullRequest) : undefined;
	}

	async createPr(options: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url?: string; error?: string }> {
		const result = await this.exec(
			"gh",
			["pr", "create", ...(options.draft ? ["--draft"] : []), "--head", options.head, "--base", options.base, "--title", options.title, "--body", options.body],
			{ cwd: this.cwd, timeout: 60_000 },
		);
		if (result.code !== 0) return { error: result.stderr.trim().split("\n")[0] || `gh exited ${result.code}` };
		return { url: result.stdout.trim().split("\n").pop() };
	}

	async searchOpenPrs(query: string): Promise<Array<{ number: number; title: string; headRefName: string; url: string }>> {
		const result = await this.exec(
			"gh",
			["pr", "list", "--state", "open", "--search", query, "--json", "number,title,headRefName,url", "--limit", "20"],
			{ cwd: this.cwd, timeout: 30_000 },
		);
		return result.code === 0 ? JSON.parse(result.stdout || "[]") : [];
	}

	async openPrFiles(): Promise<Array<{ number: number; title: string; headRefName: string; files: string[] }>> {
		const result = await this.exec(
			"gh",
			["pr", "list", "--state", "open", "--json", "number,title,headRefName,files", "--limit", "50"],
			{ cwd: this.cwd, timeout: 30_000 },
		);
		if (result.code !== 0) return [];
		const prs = JSON.parse(result.stdout || "[]") as Array<{
			number: number;
			title: string;
			headRefName: string;
			files?: Array<{ path: string }>;
		}>;
		return prs.map((p) => ({ ...p, files: (p.files ?? []).map((f) => f.path) }));
	}
}

// The issue a branch belongs to: the first key with the team prefix in its name, upper-cased.
export function branchIssue(branch: string | undefined, teamKey: string): string | undefined {
	if (!branch) return undefined;
	return new RegExp(`(?:^|[^a-z0-9])(${teamKey.toLowerCase()}-\\d+)(?![0-9])`).exec(branch.toLowerCase())?.[1].toUpperCase();
}

export function slugify(text: string, max = 40): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
}
