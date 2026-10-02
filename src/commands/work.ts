import { basename, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { issueBriefing } from "../briefing.ts";
import { containsCheckpoint, latestCheckpoint, redactSecrets } from "../checkpoint.ts";
import { branchIssue, slugify, type WorkingState } from "../git.ts";
import type { Issue, IssueRef } from "../linear.ts";
import { isOpen } from "../linear.ts";
import { METADATA_HEADING, parseMetadata, stripMetadata } from "../metadata.ts";
import { errorText, type RepoContext, type Team, TeamError } from "../runtime.ts";
import { evaluateFinish, evaluateStart, formatFinish, specStaleness } from "../work.ts";

const SUBCOMMANDS = ["next", "start", "status", "checkpoint", "block", "resume", "push", "finish"];

export function registerWork(team: Team): void {
	team.pi.registerCommand("work", {
		description: "Coordinate one issue: next | start | status | checkpoint | block | resume | push | finish",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			try {
				switch (sub) {
					case "next":
						return await next(team, ctx);
					case "start":
						return await start(team, arg, ctx);
					case "status":
						return await status(team, arg, ctx);
					case "checkpoint":
						return await checkpoint(team, arg, ctx);
					case "block":
						return await block(team, arg, ctx);
					case "resume":
						return await resume(team, arg, ctx);
					case "push":
						return await push(team, ctx);
					case "finish":
						return await finish(team, arg, ctx);
					default:
						ctx.ui.notify(`Unknown /work ${sub}. Use: ${SUBCOMMANDS.join(", ")}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(`/work ${sub}: ${errorText(error)}`, error instanceof TeamError ? "warning" : "error");
			}
		},
	});
}

function line(ref: IssueRef): string {
	const blockers = ref.openBlockers?.length ? ` · waiting on ${ref.openBlockers.join(", ")}` : "";
	return `- ${ref.identifier} ${ref.title} (${ref.state.name}, ${ref.assignee?.name ?? "unassigned"})${blockers}`;
}

async function next(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await team.requireRepo(ctx);
	const linear = team.linear();
	const { teamKey, states } = team.config.linear;
	// Filter by state id: names in team.json are matched case-insensitively, Linear's filters are not.
	const [ready, inProgress, backlog] = await Promise.all((["ready", "inProgress", "backlog"] as const).map((s) => team.stateId(teamKey, s)));
	const base = { team: { key: { eq: teamKey } } };
	const here = repo.profile ? { labels: { some: { name: { eq: repo.profile.linear.label } } } } : {};
	const [mine, unassigned, planned] = await Promise.all([
		linear.issues({ ...base, assignee: { isMe: { eq: true } }, state: { id: { in: [ready, inProgress] } } }, 50),
		linear.issues({ ...base, assignee: { null: true }, state: { id: { eq: ready } }, ...here }, 50),
		linear.issues({ ...base, state: { id: { eq: backlog } }, description: { contains: METADATA_HEADING }, ...here }, 50),
	]);
	const free = (refs: IssueRef[]) => refs.filter((r) => !r.openBlockers?.length);
	const list = (refs: IssueRef[]) => (refs.length ? refs.map(line) : ["- none"]);
	const waiting = [...mine, ...unassigned].filter((r) => r.openBlockers?.length);
	const out = ["Recommendations only; /work start claims nothing without your confirmation.", ""];
	out.push("Assigned to you:", ...list(free(mine)), "");
	out.push(`Unassigned ${states.ready}${repo.profile ? ` (${repo.profile.linear.label})` : ""}:`, ...list(free(unassigned)));
	if (waiting.length) out.push("", "Waiting on prerequisites:", ...waiting.map(line));
	// Planned slices start in Backlog while they have dependencies; nothing moves them when those finish.
	const unblocked = free(planned);
	if (unblocked.length) out.push("", `Planned slices in ${states.backlog} whose prerequisites are done (move to ${states.ready} in Linear):`, ...unblocked.map(line));
	if (mine.more || unassigned.more || planned.more) out.push("", "More issues match than are shown; see Linear for the full lists.");
	team.report(out.join("\n"));
}

function targetBranch(team: Team, issue: Issue, existing: string[], current: string | undefined): { name: string; existing: boolean; remote?: string } {
	const locals = existing.filter((b) => !b.startsWith("origin/"));
	// With several local branches for the issue, the one this checkout is on wins.
	const local = locals.find((b) => b === current) ?? locals[0];
	if (local) return { name: local, existing: true };
	const remote = existing.find((b) => b.startsWith("origin/"));
	if (remote) return { name: remote.slice("origin/".length), existing: false, remote };
	return { name: `${team.config.git.branchPrefix}${issue.identifier}-${slugify(issue.title)}`, existing: false };
}

type Checkout = { kind: "here" } | { kind: "switch" } | { kind: "worktree"; dir: string } | { kind: "elsewhere"; dir: string };

// Decide where the implementation happens. Nothing is changed here.
async function chooseCheckout(
	team: Team,
	repo: RepoContext,
	branch: { name: string; existing: boolean },
	git: WorkingState,
	ctx: ExtensionCommandContext,
): Promise<Checkout | undefined> {
	if (git.branch === branch.name) return { kind: "here" };
	const elsewhere = branch.existing ? await repo.git.worktreeFor(branch.name) : undefined;
	if (elsewhere) return { kind: "elsewhere", dir: elsewhere };
	const dirty = git.changed.length + git.untracked.length > 0;
	const dir = resolve(repo.root, team.config.git.worktreeDir.replace("{repo}", basename(repo.root)), branch.name.replace(/\//g, "-"));
	if (!ctx.hasUI) {
		if (dirty) throw new TeamError(`This checkout has uncommitted work and is not on ${branch.name}; start interactively to choose a worktree`);
		return { kind: "switch" };
	}
	const worktree = `Create worktree ${dir}`;
	const switchHere = `Switch this checkout to ${branch.name}`;
	const choice = await ctx.ui.select(
		dirty ? `This checkout has uncommitted work, which will be left alone. Implement ${branch.name} in:` : `Implement ${branch.name} in:`,
		dirty ? [worktree, "Cancel"] : [switchHere, worktree, "Cancel"],
	);
	if (choice === worktree) return { kind: "worktree", dir };
	if (choice === switchHere) return { kind: "switch" };
	return undefined;
}

async function start(team: Team, arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const key = await team.resolveIssueKey(arg, ctx);
	const repo = await team.requireRepo(ctx);
	const linear = team.linear();
	const [viewer, issue] = await Promise.all([team.viewer(), team.requireIssue(key)]);
	const fetched = await repo.git.fetch("origin", repo.defaultRef.replace(/^origin\//, ""));
	const git = await repo.git.state();
	if (!git) throw new TeamError("Not inside a git repository");
	const meta = parseMetadata(issue.description);

	const active = await linear.issues({ team: { key: { eq: issue.team.key } }, state: { type: { eq: "started" } } }, 500);
	const others = active.filter((i) => i.identifier !== issue.identifier);
	const myOtherActive = others.filter((i) => i.assignee?.id === viewer.id && team.isState(i, "inProgress"));
	const overlaps = meta.spec
		? others.filter((i) => {
				const other = parseMetadata(i.description);
				return other.spec === meta.spec && other.requirements.some((r) => meta.requirements.includes(r));
			})
		: [];
	const branches = await repo.git.branchesFor(issue.identifier);
	const branch = targetBranch(team, issue, branches, git.branch);
	const pr = await repo.gh.prForBranch(branch.name);
	const latest = latestCheckpoint(issue.comments);
	const staleness = await specStaleness(repo.git, meta, repo.profile?.name, repo.defaultRef);

	const evaluation = evaluateStart({
		issue,
		inProgress: team.isState(issue, "inProgress"),
		viewer,
		myOtherActive,
		blockedLabel: team.config.linear.blockedLabel,
		git,
		branches,
		pr,
		staleness,
		overlaps,
		latest,
	});
	if (!fetched) evaluation.notes.push(`Could not fetch ${repo.defaultRef}; comparisons use the local copy.`);
	if (active.more) evaluation.notes.push(`More than ${active.length} issues are in progress; the checks for your other active work and for overlapping slices cover only those.`);
	if (meta.repo && repo.profile && meta.repo !== repo.profile.name) {
		evaluation.refuse.push(`${issue.identifier} belongs to ${meta.repo}, but this checkout is ${repo.profile.name}`);
	}

	const summary = [`/work start ${issue.identifier}: ${issue.title}`];
	const notes = () => evaluation.notes.map((n) => `- ${n}`);
	if (evaluation.refuse.length) {
		team.report([...summary, "", "Refused:", ...evaluation.refuse.map((r) => `- ${r}`), ...notes()].join("\n"));
		return;
	}
	if (!ctx.hasUI && evaluation.confirm.length) {
		team.report([...summary, "", "Needs confirmation in an interactive session:", ...evaluation.confirm.map((c) => `- ${c}`)].join("\n"));
		return;
	}
	for (const question of evaluation.confirm) {
		if (!(await ctx.ui.confirm(`Start ${issue.identifier}?`, question))) {
			ctx.ui.notify(`Did not start ${issue.identifier}; nothing was changed`, "info");
			return;
		}
	}

	// Every decision is taken before anything changes.
	const checkout = await chooseCheckout(team, repo, branch, git, ctx);
	if (!checkout) {
		ctx.ui.notify(`Did not start ${issue.identifier}; nothing was changed`, "info");
		return;
	}
	// Linear has no atomic claim: re-read just before writing to narrow the window, and never overwrite another owner.
	const current = await team.requireIssue(issue.identifier);
	if ((current.assignee && current.assignee.id !== viewer.id) || !isOpen(current)) {
		const change = isOpen(current) ? `assigned to ${current.assignee?.name}` : `moved to ${current.state.name}`;
		team.report([...summary, "", `Refused: ${issue.identifier} was ${change} while this was being prepared. Nothing in Linear was changed.`].join("\n"));
		return;
	}

	const startPoint = branch.remote ?? repo.defaultRef;
	let workGit = repo.git;
	if (checkout.kind === "worktree") {
		const result = await repo.git.addWorktree(checkout.dir, branch.name, startPoint, branch.existing);
		if (result.code !== 0) throw new TeamError(`git worktree add failed: ${result.stderr.trim()}`);
		workGit = repo.git.at(checkout.dir);
	} else if (checkout.kind === "elsewhere") {
		// The branch already has a worktree. Linear is still brought up to date from here, so a start that
		// failed after creating the worktree can simply be run again.
		workGit = repo.git.at(checkout.dir);
	} else if (checkout.kind === "switch") {
		// A branch known only on origin is created from origin/<name> explicitly, which also works with several remotes.
		const result = await repo.git.switchTo(branch.name, startPoint, branch.existing);
		if (result.code !== 0) throw new TeamError(`git switch failed: ${result.stderr.trim()}`);
	}

	const update: { assigneeId?: string; stateId?: string } = {};
	if (!current.assignee) update.assigneeId = viewer.id;
	if (!team.isState(current, "inProgress")) update.stateId = await team.stateId(current.team.key, "inProgress");
	if (Object.keys(update).length) await linear.updateIssue(current.id, update);

	const started = await team.requireIssue(issue.identifier);
	// A start checkpoint records the session association. It never replaces existing progress with a blank one:
	// a handoff carries the previous owner's remaining work forward, and the same owner simply continues.
	let result: { message: string };
	if (!latest) {
		result = await team.postCheckpoint(started, { kind: "start", done: [], remaining: ["All acceptance"], checks: [], next: "Begin the first bounded slice" }, ctx, workGit);
	} else if (latest.author && latest.author !== viewer.name) {
		result = await team.postCheckpoint(
			started,
			{
				kind: "start",
				done: [`Took over from ${latest.author} at checkpoint ${latest.id}`, ...latest.done],
				remaining: latest.remaining ?? [`See checkpoint ${latest.id}`],
				checks: [],
				blocker: latest.blocker,
				next: latest.next ?? `Continue from checkpoint ${latest.id}`,
			},
			ctx,
			workGit,
		);
	} else {
		result = { message: `Continuing from checkpoint ${latest.id} (${latest.kind}).` };
	}
	const moved = update.stateId ? ` Moved to ${team.config.linear.states.inProgress}.` : "";

	if (checkout.kind === "worktree" || checkout.kind === "elsewhere") {
		// A session cannot change its working directory, so the work continues in a session started there.
		const what = checkout.kind === "worktree" ? `Created worktree ${checkout.dir} on ${branch.name}.` : `${branch.name} is already checked out at ${checkout.dir}.`;
		team.report([...summary, ...notes(), "", `${result.message}${moved}`, what, `Continue there: cd ${checkout.dir} && pi-team, then /work resume ${issue.identifier}`].join("\n"));
		return;
	}
	team.setState({ issue: issue.identifier, mode: "implement" }, ctx);
	team.report([...summary, ...notes(), "", `${result.message}${moved}`].join("\n"));
	team.pi.sendMessage(
		{ customType: "pi-team-briefing", content: issueBriefing(started, repo.profile, latest), display: true },
		{ triggerTurn: false },
	);
}

async function status(team: Team, arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await team.requireRepo(ctx);
	const git = await repo.git.state();
	if (!git) throw new TeamError("Not inside a git repository");
	const key = team.issueKeyFrom(arg) ?? team.state.issue ?? team.issueKeyFrom(git.branch);
	const out = [
		`Session: ${key ?? "no issue"} · mode ${team.state.mode} · profile ${repo.profile?.name ?? "none"}`,
		`Branch: ${git.branch ?? "detached"} @ ${git.head?.slice(0, 12) ?? "?"} · ${team.unsyncedState(git).join("; ") || "clean and pushed"}`,
	];
	const pending = repo.pending.list();
	if (pending.length) out.push(`Unsynced checkpoints: ${pending.map((p) => `${p.issue} ${p.id}${p.uncertain ? " (outcome uncertain)" : ""}`).join(", ")}`);
	if (key) {
		try {
			const issue = await team.requireIssue(key);
			const latest = latestCheckpoint(issue.comments);
			out.push(
				`Linear: ${issue.state.name} · ${issue.assignee?.name ?? "unassigned"}${issue.labels.length ? ` · ${issue.labels.join(", ")}` : ""}`,
				latest ? `Latest checkpoint: ${latest.id} (${latest.kind}) ${latest.createdAt} by ${latest.author ?? "?"}; next: ${latest.next ?? "?"}` : "No checkpoint yet",
			);
		} catch (error) {
			out.push(`Linear unavailable: ${errorText(error)}. Showing local state only; shared state is unconfirmed.`);
		}
	}
	team.report(out.join("\n"));
}

async function checkpoint(team: Team, note: string, ctx: ExtensionCommandContext): Promise<void> {
	const key = await team.resolveIssueKey(undefined, ctx);
	const [issue, viewer] = await Promise.all([team.requireIssue(key), team.viewer()]);
	if (issue.assignee?.id !== viewer.id) throw new TeamError(`${key} is not assigned to you; checkpoints record the owner's progress`);
	// The human asked for it explicitly, so a session left in spec or review mode returns to implementation.
	team.setState({ issue: key, mode: "implement" }, ctx);
	team.ask(
		[
			`Record a checkpoint for ${key} now by calling team_checkpoint (kind "progress").`,
			"Include what is done, what acceptance remains, the blocker if any and the next concrete action.",
			"List only checks actually run in this session, with their real result and scope. Do not report a check you did not run.",
			note ? `Note from the human: ${note}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		ctx,
	);
}

async function block(team: Team, arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const clear = /^--clear\b/.test(arg);
	const reason = redactSecrets(arg.replace(/^--clear\b/, "").trim());
	if (!clear && !reason) throw new TeamError("Usage: /work block <what is blocking and who can unblock it>  |  /work block --clear [note]");
	const key = await team.resolveIssueKey(undefined, ctx);
	const [issue, viewer] = await Promise.all([team.requireIssue(key), team.viewer()]);
	if (issue.assignee?.id !== viewer.id) throw new TeamError(`${key} is not assigned to you; raise the blocker with its owner or comment in Linear`);
	const linear = team.linear();
	const labelId = await linear.labelId(team.config.linear.blockedLabel, issue.team.id);
	if (!labelId) throw new TeamError(`No "${team.config.linear.blockedLabel}" label in Linear; create it or fix team.json`);
	const comment = clear
		? `**Unblocked** (pi-team)${reason ? `: ${reason}` : ""}`
		: `**Blocked** (pi-team): ${reason}\n\nWorkflow state is unchanged; the label and this comment keep the blocker visible.`;
	await linear.updateIssue(issue.id, clear ? { removedLabelIds: [labelId] } : { addedLabelIds: [labelId] });
	try {
		await linear.comment(issue.id, comment);
	} catch (error) {
		throw new TeamError(`The "${team.config.linear.blockedLabel}" label was ${clear ? "removed" : "added"} on ${key}, but the explanatory comment failed (${errorText(error)}). Add it in Linear.`);
	}
	ctx.ui.notify(clear ? `${key} unblocked` : `${key} marked blocked. Record a checkpoint if the state of the work changed.`, "info");
}

async function resume(team: Team, arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const key = await team.resolveIssueKey(arg, ctx);
	const repo = await team.requireRepo(ctx);
	const linear = team.linear();
	const git = await repo.git.state();
	if (!git) throw new TeamError("Not inside a git repository");
	const out = [`/work resume ${key}`];

	let issue: Issue;
	let viewer: { id: string; name: string };
	try {
		[issue, viewer] = await Promise.all([team.requireIssue(key), team.viewer()]);
	} catch (error) {
		if (error instanceof TeamError) throw error;
		team.report(
			[
				...out,
				`Linear unavailable: ${errorText(error)}.`,
				"Shared state is stale: do not claim ownership or make shared transitions until Linear is reachable.",
				`Local: ${git.branch ?? "detached"} @ ${git.head?.slice(0, 12)} · ${team.unsyncedState(git).join("; ") || "clean"}`,
			].join("\n"),
		);
		return;
	}

	const owner = issue.assignee?.id === viewer.id;
	if (!owner) {
		out.push(
			issue.assignee
				? `Owned by ${issue.assignee.name}. This session is read-only assistance (review mode); implementation needs an explicit reassignment in Linear.`
				: "Unassigned. This session is read-only (review mode); take the issue explicitly with /work start.",
		);
	}

	const pending = repo.pending.get(key);
	if (pending) {
		if (containsCheckpoint(issue.comments, pending.id)) {
			repo.pending.clear(key);
			out.push(`Pending checkpoint ${pending.id} had been stored; cleared the local copy.`);
		} else {
			out.push(`Unsynced local checkpoint ${pending.id} from ${pending.createdAt} (${pending.error || "not posted"}).`);
			if (owner && ctx.hasUI && (await ctx.ui.confirm("Post unsynced checkpoint?", `${pending.id} was never confirmed in Linear. Post it now?`))) {
				try {
					await linear.comment(issue.id, pending.body);
					repo.pending.clear(key);
					out.push(`Posted ${pending.id}.`);
					issue = await team.requireIssue(key);
				} catch (error) {
					out.push(`Still not synced: ${errorText(error)}`);
				}
			}
		}
	}

	const latest = latestCheckpoint(issue.comments);
	if (latest) {
		out.push(`Latest checkpoint ${latest.id} (${latest.kind}) by ${latest.author ?? "?"} at ${latest.createdAt}.`);
		if (latest.branch && git.branch && latest.branch !== git.branch) out.push(`Checkpoint branch ${latest.branch} differs from this checkout (${git.branch}).`);
		if (latest.commit && git.head && !git.head.startsWith(latest.commit)) {
			const since = await repo.git.run(["log", "--oneline", `${latest.commit}..HEAD`]);
			out.push(since === undefined ? `Checkpoint commit ${latest.commit} is not in this clone; fetch the branch.` : `Commits since checkpoint:\n${since || "(none; HEAD is behind or diverged)"}`);
		}
	} else {
		out.push("No checkpoint yet.");
	}
	const unsynced = team.unsyncedState(git);
	if (unsynced.length) out.push(`Local work newer than any checkpoint may exist: ${unsynced.join("; ")}.`);
	const pr = git.branch ? await repo.gh.prForBranch(git.branch) : undefined;
	if (pr) out.push(`PR #${pr.number} ${pr.state}${pr.isDraft ? " (draft)" : ""}: ${pr.url}`);

	team.checkpointedHead = latest?.commit && git.head?.startsWith(latest.commit) ? git.head : undefined;
	team.setState({ issue: key, mode: owner ? "implement" : "review" }, ctx);
	team.report(out.join("\n"));
	team.pi.sendMessage(
		{ customType: "pi-team-briefing", content: issueBriefing(issue, repo.profile, latest), display: true },
		{ triggerTurn: false },
	);
}

// Commands inside a session run in the sandbox, which has no host credentials. Publishing the branch is
// therefore a host-side step the owner asks for explicitly: one branch, to its own name, never forced.
async function push(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const key = await team.resolveIssueKey(undefined, ctx);
	const repo = await team.requireRepo(ctx);
	const git = await repo.git.state();
	if (!git?.branch || !git.head) throw new TeamError("This checkout is not on a branch with commits");
	const base = repo.defaultRef.replace(/^origin\//, "");
	if (git.branch === base) throw new TeamError(`/work push publishes issue branches, not ${base}`);
	if (branchIssue(git.branch, team.config.linear.teamKey) !== key) throw new TeamError(`This checkout is on ${git.branch}, which is not ${key}'s branch`);
	const [issue, viewer] = await Promise.all([team.requireIssue(key), team.viewer()]);
	if (issue.assignee?.id !== viewer.id) throw new TeamError(`${key} is not assigned to you`);

	const existing = await repo.gh.prForBranch(git.branch);
	if (repo.gh.lastError) throw new TeamError(`Could not query GitHub (${repo.gh.lastError}); nothing was pushed`);
	const open = existing?.state === "OPEN" ? existing : undefined;
	const ahead = await repo.git.aheadOf(repo.defaultRef);
	if (ahead === 0) throw new TeamError(`${git.branch} has no commits beyond ${repo.defaultRef}`);
	const dirty = git.changed.length + git.untracked.length;
	const plan = [
		`Push ${git.branch} (${ahead ?? "?"} commit(s) beyond ${repo.defaultRef}) to origin${open ? `; PR #${open.number} is already open` : " and open a draft pull request"}.`,
		dirty ? `${dirty} uncommitted file(s) are not included.` : "",
	].filter(Boolean).join("\n");
	if (ctx.hasUI && !(await ctx.ui.confirm(`Publish ${key}?`, plan))) {
		ctx.ui.notify("Nothing was pushed", "info");
		return;
	}

	const pushed = await repo.git.push(git.branch);
	if (pushed.code !== 0) throw new TeamError(`git push failed: ${pushed.stderr.trim().split("\n").slice(-2).join(" ")}`);
	const out = [`Pushed ${git.branch} at ${git.head.slice(0, 12)} to origin.`];
	if (open) out.push(`PR #${open.number}: ${open.url}`);
	else {
		const acceptance = stripMetadata(issue.description);
		const body = redactSecrets([`Linear: ${issue.url}`, "", "## Acceptance", acceptance.length > 4000 ? `${acceptance.slice(0, 4000)}\n…` : acceptance || "(see the issue)"].join("\n"));
		const created = await repo.gh.createPr({ head: git.branch, base, title: `${key}: ${issue.title}`, body, draft: true });
		out.push(created.url ? `Opened draft PR: ${created.url}` : `The branch is pushed, but the pull request was not created (${created.error}). Open it by hand.`);
	}
	if (dirty) out.push(`${dirty} uncommitted file(s) were left out.`);
	team.report(out.join("\n"));
}

async function finish(team: Team, arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const key = await team.resolveIssueKey(arg, ctx);
	const repo = await team.requireRepo(ctx);
	await repo.git.fetch("origin", repo.defaultRef.replace(/^origin\//, ""));
	const [issue, viewer] = await Promise.all([team.requireIssue(key), team.viewer()]);
	const git = await repo.git.state();
	if (!git) throw new TeamError("Not inside a git repository");
	// The summary from `gh pr list` lacks reviews and remote checks, so a failed detail query means "unconfirmed",
	// never a silent fallback.
	// The PR belongs to the issue's branch, which need not be the current one: after a merge the branch may be
	// deleted and this checkout back on the default branch. The last checkpoint records the branch name.
	const teamKey = team.config.linear.teamKey;
	const latest = latestCheckpoint(issue.comments);
	const issueBranch = branchIssue(git.branch, teamKey) === key ? git.branch : (latest?.branch ?? (await repo.git.branchesFor(key))[0]?.replace(/^origin\//, ""));
	const listed = issueBranch ? await repo.gh.prForBranch(issueBranch) : undefined;
	let prError = repo.gh.lastError;
	const pr = listed ? await repo.gh.prDetail(listed.number) : undefined;
	if (listed && !pr) prError = repo.gh.lastError ?? "gh pr view failed";
	const report = evaluateFinish({
		issue,
		inProgress: team.isState(issue, "inProgress"),
		git,
		integrated: git.head ? await repo.git.isAncestor(git.head, repo.defaultRef) : false,
		pr,
		prError,
		review: repo.reviews.get(key),
		staleness: await specStaleness(repo.git, parseMetadata(issue.description), repo.profile?.name, repo.defaultRef),
		blockedLabel: team.config.linear.blockedLabel,
	});
	const text = formatFinish(key, report);
	const owner = issue.assignee?.id === viewer.id;
	const { states } = team.config.linear;

	if (owner && ctx.hasUI && report.transition === "done") {
		const judgement = report.lines.filter((l) => l.ok === undefined).map((l) => `? ${l.label}: ${l.detail}`);
		const question = [`Every recorded condition for ${key} is met.`, ...judgement, "", `Is all acceptance, including any live gate, genuinely met? Move to ${states.done}?`].join("\n");
		if (await ctx.ui.confirm(`Complete ${key}?`, question)) {
			await team.linear().updateIssue(issue.id, { stateId: await team.stateId(issue.team.key, "done") });
			team.report(`${text}\n\nMoved ${key} to ${states.done}.`);
			return;
		}
		team.report(`${text}\n\nLeft in ${issue.state.name}.`);
		return;
	}
	if (owner && ctx.hasUI && report.transition === "inReview") {
		const unmet = report.lines.find((l) => l.label === "Acceptance" && l.ok === false);
		const question = [`PR #${pr?.number} is open and the change is ready for another person to review.`, unmet ? `Still unmet and blocking ${states.done}: ${unmet.detail}` : ""].filter(Boolean).join("\n");
		if (await ctx.ui.confirm(`Move ${key} to ${states.inReview}?`, question)) {
			await team.linear().updateIssue(issue.id, { stateId: await team.stateId(issue.team.key, "inReview") });
			team.report(`${text}\n\nMoved ${key} to ${states.inReview}.`);
		} else {
			team.report(text);
		}
		if (report.assessed) return;
	} else {
		team.report(text);
	}

	if (report.assessed || !owner) return;
	if (!report.assessable) {
		const hint = pr
			? "Resolve the ✗ items on checks and review first; the acceptance assessment waits for a commit that passes them. Then run /work finish again."
			: `No pull request was found for ${issueBranch ?? "this issue"}. Run /work finish from the issue's branch once checks and /review have passed there.`;
		team.report(hint);
		return;
	}
	// The assessment is recorded against the commit under judgement, which after a merge is not this checkout's HEAD.
	team.assessing = { issue: key, commit: report.subject!, branch: issueBranch };
	team.setState({ issue: key, mode: "implement" }, ctx);
	team.ask(
		[
			`Assess ${key} against its acceptance for /work finish. The mechanical report is above.`,
			"1. Read the acceptance (team_issue_read) and, if referenced, the spec requirements.",
			"2. For each acceptance item say met, unmet or not verifiable here, citing the diff, a test or a recorded check. Runtime or live acceptance is unmet unless live evidence is recorded.",
			"3. Do not move unmet acceptance to another issue to make completion possible.",
			'4. Call team_checkpoint with kind "final". `remaining` must list exactly the acceptance items that are unmet or unverified (empty only if every item is met); put unmet mechanical conditions from the report in `next`.',
			`Then tell the human to run /work finish again: it offers ${states.inReview} or ${states.done} only when the evidence supports it, and the human decides.`,
		].join("\n"),
		ctx,
	);
}
