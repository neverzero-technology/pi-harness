import type { CheckResult, ParsedCheckpoint } from "./checkpoint.ts";
import { checkpoints, latestChecks } from "./checkpoint.ts";
import type { Git, PullRequest, WorkingState } from "./git.ts";
import { humanReview } from "./git.ts";
import type { Issue, IssueRef } from "./linear.ts";
import { isOpen } from "./linear.ts";
import type { IssueMetadata } from "./metadata.ts";

export interface SpecStaleness {
	status: "current" | "changed" | "unverifiable" | "none";
	detail: string;
}

// Has the spec this issue was planned from changed on the default branch since planning?
// Any change warns; a human decides whether it matters.
export async function specStaleness(
	git: Git,
	meta: IssueMetadata,
	currentRepo: string | undefined,
	defaultRef: string,
): Promise<SpecStaleness> {
	if (!meta.spec) return { status: "none", detail: "No spec recorded; the issue is its own acceptance" };
	if (meta.specRepo && meta.specRepo !== currentRepo) {
		return { status: "unverifiable", detail: `Spec lives in ${meta.specRepo}:${meta.spec}; check it there` };
	}
	if (!meta.specCommit) return { status: "unverifiable", detail: `No planning revision recorded for ${meta.spec}` };
	if (!(await git.commitExists(meta.specCommit))) {
		return { status: "unverifiable", detail: `Planning revision ${meta.specCommit} is not in this clone (fetch first)` };
	}
	const changes = await git.changesSince(meta.spec, meta.specCommit, defaultRef);
	if (changes.length === 0) return { status: "current", detail: `${meta.spec} unchanged since ${meta.specCommit}` };
	return {
		status: "changed",
		detail: `${meta.spec} changed on ${defaultRef} since planning (${meta.specCommit}):\n${changes.map((c) => `    ${c}`).join("\n")}`,
	};
}

export interface StartInput {
	issue: Issue;
	inProgress: boolean; // the issue is already in the team's "In Progress" state
	viewer: { id: string; name: string };
	myOtherActive: IssueRef[];
	blockedLabel: string;
	git: WorkingState;
	branches: string[];
	pr: PullRequest | undefined;
	staleness: SpecStaleness;
	overlaps: IssueRef[];
	latest: ParsedCheckpoint | undefined;
}

export interface Evaluation {
	refuse: string[];
	confirm: string[];
	notes: string[];
}

export function evaluateStart(s: StartInput): Evaluation {
	const e: Evaluation = { refuse: [], confirm: [], notes: [] };
	const { issue } = s;

	if (!isOpen(issue)) e.refuse.push(`${issue.identifier} is ${issue.state.name}`);
	if (issue.assignee && issue.assignee.id !== s.viewer.id) {
		e.refuse.push(
			`${issue.identifier} is assigned to ${issue.assignee.name}. Ownership changes are explicit: reassign it in Linear first.`,
		);
	}
	if (!issue.assignee) e.confirm.push(`${issue.identifier} is unassigned; assign it to you (${s.viewer.name})?`);

	const openBlockers = issue.blockers.filter(isOpen);
	if (openBlockers.length) {
		e.confirm.push(
			`Open prerequisites: ${openBlockers.map((b) => `${b.identifier} (${b.state.name})`).join(", ")}. Source work may still proceed if they gate only live acceptance.`,
		);
	}
	if (issue.labels.some((l) => l.toLowerCase() === s.blockedLabel.toLowerCase())) {
		e.confirm.push(`${issue.identifier} carries the "${s.blockedLabel}" label`);
	}
	if (issue.state.type === "backlog" || issue.state.type === "triage") {
		e.confirm.push(`${issue.identifier} is in ${issue.state.name}, not Ready`);
	}
	if (issue.state.type === "started" && !s.inProgress) {
		e.confirm.push(`${issue.identifier} is in ${issue.state.name}; starting work moves it back to In Progress`);
	}
	if (s.myOtherActive.length) {
		e.confirm.push(
			`You already have active work: ${s.myOtherActive.map((i) => `${i.identifier} (${i.state.name})`).join(", ")}. The default is one active implementation issue per person.`,
		);
	}
	if (s.staleness.status === "changed") e.confirm.push(s.staleness.detail);
	else if (s.staleness.status !== "current") e.notes.push(s.staleness.detail);

	if (s.overlaps.length) {
		e.confirm.push(
			`Active work on the same spec requirements: ${s.overlaps.map((i) => `${i.identifier} (${i.assignee?.name ?? "unassigned"})`).join(", ")}`,
		);
	}
	if (s.latest?.author && s.latest.author !== s.viewer.name) {
		e.notes.push(`Last checkpoint ${s.latest.id} was written by ${s.latest.author}; this is a handoff, so resume from it.`);
	}
	if (s.branches.length) e.notes.push(`Existing branches: ${s.branches.join(", ")}`);
	if (s.pr) e.notes.push(`Existing PR #${s.pr.number} (${s.pr.state}${s.pr.isDraft ? ", draft" : ""}): ${s.pr.url}`);

	const dirty = s.git.changed.length + s.git.untracked.length;
	if (dirty) e.notes.push(`This checkout has ${dirty} uncommitted file(s); they will be left untouched.`);
	return e;
}

export interface FinishInput {
	issue: Issue;
	inProgress: boolean; // the issue is in the team's "In Progress" state
	git: WorkingState;
	integrated: boolean; // local HEAD is contained in the default branch
	pr: PullRequest | undefined;
	prError?: string;
	review: { commit: string; verdict: string } | undefined;
	staleness: SpecStaleness;
	blockedLabel: string;
}

export interface FinishLine {
	ok: boolean | undefined; // undefined = needs human judgement
	label: string;
	detail: string;
}

export interface FinishReport {
	lines: FinishLine[];
	// What the evidence supports. The command still asks the human before any transition.
	transition: "none" | "inReview" | "done";
	assessed: boolean; // the owner's latest checkpoint at the subject commit is a final one
	// False while checks or review at this commit have failed: the commit must change, so assessing it is wasted work.
	assessable: boolean;
	// The commit the evidence is judged at: the merged PR head once merged, otherwise local HEAD.
	subject: string | undefined;
}

const at = (commit: string | undefined, subject: string | undefined) => Boolean(commit && subject?.startsWith(commit));

export function evaluateFinish(f: FinishInput): FinishReport {
	const lines: FinishLine[] = [];
	const head = f.git.head;
	const add = (ok: boolean | undefined, label: string, detail: string) => lines.push({ ok, label, detail });
	const merged = f.pr?.state === "MERGED";
	// After a merge the evidence is judged at the commit that was merged, wherever this checkout is now
	// (the branch may be deleted, or the user back on the default branch).
	const subject = merged ? f.pr?.headRefOid : head;
	const where = merged ? `the merged commit ${subject?.slice(0, 12)}` : `HEAD ${subject?.slice(0, 12)}`;

	const checks = latestChecks(f.issue.comments);
	const describe = (c: CheckResult) => `${c.command}: ${c.result} (${c.scope})`;
	const here = checks.filter((c) => at(c.commit, subject) && !c.dirty);
	const failing = here.filter((c) => c.result === "fail");
	const passing = here.filter((c) => c.result === "pass");
	const unrun = here.filter((c) => c.result === "skipped" || c.result === "unavailable");
	const elsewhere = checks.filter((c) => !here.includes(c));
	if (!checks.length) add(false, "Checks", "No check results recorded in a checkpoint");
	else if (failing.length) add(false, "Checks", failing.map(describe).join("; "));
	else if (!passing.length) add(false, "Checks", `Nothing passing at ${where} on a committed tree; rerun the affected checks and checkpoint`);
	else add(true, "Checks", `${passing.length} passing at ${where} (${[...new Set(passing.map((c) => c.scope))].join(", ")})`);
	if (unrun.length && !failing.length) add(undefined, "Checks not run", unrun.map(describe).join("; "));
	// A result from another commit or a dirty tree proves nothing about this one; a person decides whether it still matters.
	if (elsewhere.length && passing.length && !failing.length) {
		add(undefined, "Checks not rerun", elsewhere.map((c) => `${describe(c)} at ${c.commit ?? "unknown commit"}${c.dirty ? ", dirty tree" : ""}`).join("; "));
	}

	const review = f.review;
	if (!review) add(false, "Agent review", "Not run on a clean tree (/review)");
	else if (review.commit !== subject) add(false, "Agent review", `Ran at ${review.commit.slice(0, 12)}, not ${where}; rerun /review`);
	else add(review.verdict === "READY FOR HUMAN REVIEW", "Agent review", `${review.verdict} at ${where}`);

	const dirty = f.git.changed.length + f.git.untracked.length;
	if (merged) {
		// Local commits count as integrated when HEAD is the merged commit or already part of the default branch.
		const beyond = head !== f.pr?.headRefOid && !f.integrated;
		const problems = [dirty ? `${dirty} uncommitted file(s)` : "", beyond ? `local HEAD ${head?.slice(0, 12)} has commits that were not part of the merge` : ""].filter(Boolean);
		add(problems.length === 0, "Local state", problems.join(", ") || "Nothing local beyond what was merged");
	} else {
		const pushed = f.git.upstream !== undefined && !f.git.unpushed;
		add(
			dirty === 0 && pushed,
			"Local state",
			dirty === 0 && pushed ? "Clean and pushed" : [dirty ? `${dirty} uncommitted file(s)` : "", pushed ? "" : "commits not pushed"].filter(Boolean).join(", "),
		);
	}

	if (!f.pr) {
		// Review, remote checks and merge cannot be confirmed without the PR, so this is unmet either way.
		add(false, "Pull request", f.prError ? `Could not query GitHub (${f.prError}); review and merge are unconfirmed` : "None found for this issue's branch");
	} else {
		const pr = f.pr;
		if (!merged && head && pr.headRefOid !== head) {
			add(false, "PR head", `PR head ${pr.headRefOid.slice(0, 12)} differs from local HEAD ${head.slice(0, 12)}; push or pull so they match`);
		}
		const human = humanReview(pr);
		add(human.approved, "Human review", human.detail);
		const rollup = pr.statusCheckRollup ?? [];
		if (rollup.length === 0) {
			add(undefined, "Remote checks", "None reported; local evidence carries the weight");
		} else {
			const outcome = (c: (typeof rollup)[number]) => (c.conclusion || c.state || c.status || "PENDING").toUpperCase();
			const bad = rollup.filter((c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome(c)));
			add(bad.length === 0, "Remote checks", bad.length ? bad.map((c) => `${c.name ?? c.context}: ${outcome(c)}`).join("; ") : `${rollup.length} passing`);
		}
		add(merged, "Integrated", merged ? `Merged ${pr.mergedAt ?? ""}`.trim() : `PR is ${pr.state}${pr.isDraft ? " (draft)" : ""}; unmerged work belongs in review, not done`);
	}

	const openBlockers = f.issue.blockers.filter(isOpen);
	const blockedLabel = f.issue.labels.some((l) => l.toLowerCase() === f.blockedLabel.toLowerCase());
	add(
		!openBlockers.length && !blockedLabel,
		"Prerequisites",
		openBlockers.length || blockedLabel
			? [...openBlockers.map((b) => `${b.identifier} ${b.state.name}`), blockedLabel ? `"${f.blockedLabel}" label` : ""].filter(Boolean).join("; ")
			: "None open",
	);

	if (f.staleness.status === "changed") add(undefined, "Spec", f.staleness.detail);

	// The assessment is the owner's most recent word on this commit. A checkpoint by anyone else does not
	// count, and a later progress or blocked checkpoint at the same commit withdraws an earlier final one.
	const latestByOwner = checkpoints(f.issue.comments)
		.filter((cp) => at(cp.commit, subject) && cp.author !== undefined && cp.author === f.issue.assignee?.name)
		.at(-1);
	const final = latestByOwner?.kind === "final" ? latestByOwner : undefined;
	const remaining = final?.remaining;
	if (!final || remaining === undefined) add(undefined, "Acceptance", `Not yet assessed at ${where}`);
	else if (remaining.length) add(false, "Acceptance", `Unmet per ${final.id}: ${remaining.join("; ")}`);
	else add(true, "Acceptance", `Final checkpoint ${final.id} records nothing remaining`);
	const assessed = remaining !== undefined;

	const failed = new Set(lines.filter((l) => l.ok === false).map((l) => l.label));
	// Unmet acceptance (typically a live gate) blocks Done, not review of the source change.
	const awaitingOthers = ["Human review", "Remote checks", "Integrated", "Acceptance"];
	let transition: FinishReport["transition"] = "none";
	if (failed.size === 0 && assessed && merged && isOpen(f.issue)) transition = "done";
	else if (f.inProgress && f.pr?.state === "OPEN" && !f.pr.isDraft && [...failed].every((label) => awaitingOthers.includes(label))) {
		transition = "inReview";
	}
	const assessable = Boolean(subject) && !["Checks", "Agent review", "PR head"].some((label) => failed.has(label));
	return { lines, transition, assessed, assessable, subject };
}

export function formatFinish(issue: string, report: FinishReport): string {
	const mark = (ok: boolean | undefined) => (ok === true ? "✓" : ok === false ? "✗" : "?");
	const failed = report.lines.filter((l) => l.ok === false);
	const verdict = failed.length ? `NOT DONE: ${failed.length} unmet condition(s)` : "No unmet conditions; done still needs a human decision";
	return [`/work finish ${issue}: ${verdict}`, "", ...report.lines.map((l) => `${mark(l.ok)} ${l.label}: ${l.detail}`)].join("\n");
}

export interface ProposedSlice {
	key: string;
	title: string;
	acceptance: string;
	requirements: string[];
	repo: string;
	surfaces: string[];
	verification: string;
	dependsOn: string[];
}

export interface SliceReconciliation {
	reuse: Array<{ slice: ProposedSlice; issue: IssueRef }>;
	create: ProposedSlice[];
	errors: string[];
	warnings: string[];
}

// Repeated planning reuses issues whose metadata carries the same slice key.
export function reconcileSlices(
	slices: ProposedSlice[],
	existing: Array<{ issue: IssueRef; slice: string | undefined }>,
	specRequirements: string[],
): SliceReconciliation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const keys = new Set<string>();
	for (const s of slices) {
		if (keys.has(s.key)) errors.push(`Duplicate slice key ${s.key}`);
		keys.add(s.key);
		const unknown = s.requirements.filter((r) => !specRequirements.includes(r));
		if (unknown.length) errors.push(`${s.key} references requirements not in the spec: ${unknown.join(", ")}`);
		if (!s.requirements.length) errors.push(`${s.key} references no requirements`);
	}
	for (const s of slices) {
		// A key is stored in a Markdown footer and must read back exactly.
		if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s.key)) errors.push(`Slice key "${s.key}" may only contain letters, digits, ".", "_", "/" and "-"`);
	}
	const cycle = dependencyCycle(slices);
	if (cycle) errors.push(`Dependency cycle: ${cycle.join(" → ")}`);
	for (const s of slices) {
		for (const dep of s.dependsOn) {
			if (!keys.has(dep)) errors.push(`${s.key} depends on ${dep}, which is not a slice of this plan`);
			if (dep === s.key) errors.push(`${s.key} depends on itself`);
		}
	}
	const covered = new Set(slices.flatMap((s) => s.requirements));
	const uncovered = specRequirements.filter((r) => !covered.has(r));
	if (uncovered.length) warnings.push(`Requirements with no slice: ${uncovered.join(", ")}`);

	const reuse: SliceReconciliation["reuse"] = [];
	const create: ProposedSlice[] = [];
	for (const slice of slices) {
		const match = existing.find((e) => e.slice === slice.key);
		if (match) reuse.push({ slice, issue: match.issue });
		else create.push(slice);
	}
	return { reuse, create, errors, warnings };
}

function dependencyCycle(slices: ProposedSlice[]): string[] | undefined {
	const deps = new Map(slices.map((s) => [s.key, s.dependsOn]));
	const done = new Set<string>();
	const visit = (key: string, path: string[]): string[] | undefined => {
		if (path.includes(key)) return [...path.slice(path.indexOf(key)), key];
		if (done.has(key)) return undefined;
		for (const dep of deps.get(key) ?? []) {
			const found = visit(dep, [...path, key]);
			if (found) return found;
		}
		done.add(key);
		return undefined;
	};
	for (const s of slices) {
		const found = visit(s.key, []);
		if (found && found.length > 2) return found; // a self-dependency is reported separately
	}
	return undefined;
}
