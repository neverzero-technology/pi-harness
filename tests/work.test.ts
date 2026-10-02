import assert from "node:assert/strict";
import { test } from "node:test";
import { type Checkpoint, formatCheckpoint, parseCheckpoint } from "../src/checkpoint.ts";
import type { PullRequest, WorkingState } from "../src/git.ts";
import { evaluateFinish, evaluateStart, type FinishInput, formatFinish, type ProposedSlice, reconcileSlices, type StartInput } from "../src/work.ts";
import { issue, ref, STATES } from "./helpers.ts";

const viewer = { id: "u-dan", name: "Dan" };
const clean: WorkingState = { root: "/r", branch: "linear/ENG-1-x", head: "a".repeat(40), changed: [], untracked: [], upstream: "origin/linear/ENG-1-x", unpushed: 0 };

function start(patch: Partial<StartInput> = {}): StartInput {
	return {
		issue: issue("ENG-1", { assignee: { id: viewer.id, name: viewer.name } }),
		inProgress: false,
		viewer,
		myOtherActive: [],
		blockedLabel: "blocked",
		git: clean,
		branches: [],
		pr: undefined,
		staleness: { status: "current", detail: "unchanged" },
		overlaps: [],
		latest: undefined,
		...patch,
	};
}

test("start: own ready issue needs no confirmation", () => {
	const e = evaluateStart(start());
	assert.deepEqual(e.refuse, []);
	assert.deepEqual(e.confirm, []);
});

test("start: another person's issue is refused, never taken", () => {
	const e = evaluateStart(start({ issue: issue("ENG-1", { assignee: { id: "u-sam", name: "Sam" } }) }));
	assert.equal(e.refuse.length, 1);
	assert.match(e.refuse[0], /assigned to Sam/);
});

test("start: closed issues are refused", () => {
	assert.equal(evaluateStart(start({ issue: issue("ENG-1", { state: STATES.done }) })).refuse.length, 1);
});

test("start: exceptions need explicit confirmation", () => {
	const e = evaluateStart(
		start({
			issue: issue("ENG-1", {
				state: STATES.backlog,
				labels: ["Blocked"],
				blockers: [ref("ENG-0", { state: STATES.inProgress }), ref("ENG-9", { state: STATES.done })],
			}),
			myOtherActive: [ref("ENG-5", { state: STATES.inProgress })],
			staleness: { status: "changed", detail: "spec changed" },
			overlaps: [ref("ENG-7", { assignee: { id: "u-sam", name: "Sam" } })],
		}),
	);
	const text = e.confirm.join("\n");
	assert.match(text, /unassigned/);
	assert.match(text, /ENG-0 \(In Progress\)/);
	assert.doesNotMatch(text, /ENG-9/);
	assert.match(text, /"blocked" label/);
	assert.match(text, /in Backlog, not Ready/);
	assert.match(text, /ENG-5/);
	assert.match(text, /spec changed/);
	assert.match(text, /ENG-7 \(Sam\)/);
});

test("start: an issue in review is not moved back without asking", () => {
	const mine = { assignee: { id: viewer.id, name: viewer.name } };
	const inReview = evaluateStart(start({ issue: issue("ENG-1", { ...mine, state: STATES.inReview }) }));
	assert.match(inReview.confirm.join("\n"), /is in In Review; starting work moves it back to In Progress/);
	assert.deepEqual(evaluateStart(start({ issue: issue("ENG-1", { ...mine, state: STATES.inProgress }), inProgress: true })).confirm, []);
});

test("start: handoff, branches, PR and dirty checkout are reported", () => {
	const body = formatCheckpoint({ id: "cp-00000001", kind: "handoff", issue: "ENG-1", owner: "Sam", spec: "x", done: [], remaining: [], checks: [], next: "n", unsynced: [] });
	const latest = parseCheckpoint({ id: "c", body, createdAt: "2026-10-01T00:00:00Z", author: "Sam" });
	const pr = { number: 3, url: "u", state: "OPEN", isDraft: true } as PullRequest;
	const e = evaluateStart(start({ latest, branches: ["origin/linear/ENG-1-x"], pr, git: { ...clean, changed: ["a"], untracked: ["b"] } }));
	const notes = e.notes.join("\n");
	assert.match(notes, /written by Sam; this is a handoff/);
	assert.match(notes, /origin\/linear\/ENG-1-x/);
	assert.match(notes, /PR #3 \(OPEN, draft\)/);
	assert.match(notes, /2 uncommitted/);
});

const HEAD = clean.head!;
const PASS = { command: "make verify", result: "pass", scope: "local", commit: HEAD } as const;

function checkpointComment(n: number, patch: Partial<Checkpoint> = {}) {
	const body = formatCheckpoint({
		id: `cp-0000000${n}`,
		kind: "progress",
		issue: "ENG-1",
		owner: "Dan",
		spec: "x",
		commit: HEAD,
		done: [],
		remaining: ["R2"],
		checks: [PASS],
		next: "n",
		unsynced: [],
		...patch,
	});
	return { id: `c${n}`, body, createdAt: `2026-10-0${n}T00:00:00Z`, author: "Dan" };
}

const mergedPr: PullRequest = {
	number: 4,
	url: "u",
	state: "MERGED",
	isDraft: false,
	headRefName: "linear/ENG-1-x",
	headRefOid: HEAD,
	baseRefName: "main",
	reviewDecision: "APPROVED",
	mergedAt: "2026-10-01",
	author: { login: "dan" },
	latestReviews: [{ author: { login: "sam" }, state: "APPROVED" }],
	statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
};
const openPr: PullRequest = { ...mergedPr, state: "OPEN", mergedAt: null, reviewDecision: "REVIEW_REQUIRED", latestReviews: [] };

function finish(comments: ReturnType<typeof checkpointComment>[], patch: Partial<FinishInput> = {}) {
	return evaluateFinish({
		issue: issue("ENG-1", { comments, state: STATES.inProgress, assignee: { id: "u-dan", name: "Dan" } }),
		inProgress: true,
		git: clean,
		integrated: false,
		pr: mergedPr,
		review: { commit: HEAD, verdict: "READY FOR HUMAN REVIEW" },
		staleness: { status: "current", detail: "" },
		blockedLabel: "blocked",
		...patch,
	});
}
const failed = (report: ReturnType<typeof finish>) => report.lines.filter((l) => l.ok === false).map((l) => l.label);
const final = (n: number, remaining: string[] = []) => checkpointComment(n, { kind: "final", remaining, checks: [] });

test("finish: everything met and assessed offers done, never without a final checkpoint", () => {
	const unassessed = finish([checkpointComment(1)]);
	assert.deepEqual(failed(unassessed), []);
	assert.equal(unassessed.transition, "none");
	assert.equal(unassessed.assessed, false);
	assert.equal(unassessed.assessable, true);
	assert.equal(finish([checkpointComment(1)], { review: { commit: HEAD, verdict: "CHANGES NEEDED" } }).assessable, false);
	assert.equal(finish([checkpointComment(1)], { pr: openPr }).assessable, true, "waiting on other people does not block the assessment");

	const report = finish([checkpointComment(1), final(2)]);
	assert.deepEqual(failed(report), []);
	assert.equal(report.transition, "done");
	assert.match(formatFinish("ENG-1", report), /No unmet conditions/);
});

test("finish: done needs a merged PR, and local commits beyond the merge are not integrated", () => {
	const assessed = [checkpointComment(1), final(2)];
	// Open and approved, everything else met: not done.
	const approvedOpen = finish(assessed, { pr: { ...mergedPr, state: "OPEN", mergedAt: null } });
	assert.deepEqual(failed(approvedOpen), ["Integrated"]);
	assert.notEqual(approvedOpen.transition, "done");
	// Merged at commit E; this branch has a later commit (HEAD) that was never merged. The evidence is judged
	// at E, where nothing was recorded, and the extra local commit is called out.
	const ahead = finish(assessed, { pr: { ...mergedPr, headRefOid: "e".repeat(40) } });
	assert.deepEqual(failed(ahead).sort(), ["Agent review", "Checks", "Local state"]);
	assert.match(ahead.lines.find((l) => l.label === "Local state")!.detail, /has commits that were not part of the merge/);
	assert.equal(ahead.transition, "none");
	assert.equal(ahead.subject, "e".repeat(40));
});

test("finish: after a merge the evidence is judged at the merged commit, from any checkout", () => {
	const assessed = [checkpointComment(1), final(2)];
	// Squash merge, branch deleted, the owner back on main: HEAD is a different commit that contains the merge.
	const onMain = { ...clean, branch: "main", head: "f".repeat(40), upstream: "origin/main" };
	const report = finish(assessed, { git: onMain, integrated: true });
	assert.deepEqual(failed(report), []);
	assert.equal(report.transition, "done");
	assert.equal(report.subject, HEAD);
	assert.match(report.lines.find((l) => l.label === "Checks")!.detail, /at the merged commit a{12}/);
	// The same checkout with uncommitted files is not clean.
	assert.deepEqual(failed(finish(assessed, { git: { ...onMain, changed: ["x"] }, integrated: true })), ["Local state"]);
	// On main but the PR is still open: evidence is judged at main's HEAD, where there is none.
	const open = finish(assessed, { git: onMain, integrated: true, pr: openPr });
	assert.ok(failed(open).includes("Checks") && failed(open).includes("PR head"));
	assert.equal(open.assessable, false);
});

test("finish: results from other commits are shown for judgement, not counted", () => {
	const old = { command: "make e2e", result: "fail", scope: "ci", commit: "b".repeat(40) } as const;
	const report = finish([checkpointComment(1, { checks: [old] }), checkpointComment(2), final(3)]);
	assert.deepEqual(failed(report), [], "a failure at an older commit does not block for ever");
	const line = report.lines.find((l) => l.label === "Checks not rerun")!;
	assert.equal(line.ok, undefined);
	assert.match(line.detail, /make e2e: fail \(ci\) at b{12}/);
	// But with nothing passing at this commit there is no evidence at all.
	assert.deepEqual(failed(finish([checkpointComment(1, { checks: [old] })])), ["Checks"]);
});

test("finish: a later checkpoint at the same commit withdraws an earlier assessment", () => {
	const withdrawn = finish([checkpointComment(1), final(2), checkpointComment(3, { kind: "progress", remaining: ["R3 is not actually done"], checks: [] })]);
	assert.equal(withdrawn.assessed, false);
	assert.equal(withdrawn.transition, "none");
	// A fresh final restores it.
	assert.equal(finish([checkpointComment(1), final(2), checkpointComment(3, { kind: "progress", checks: [] }), final(4)]).transition, "done");
});

test("finish: a final checkpoint without a Remaining section is not an assessment", () => {
	const mangled = final(2);
	mangled.body = mangled.body.replace(/\*\*Remaining\*\*\n- none\n\n/, "");
	const report = finish([checkpointComment(1), mangled]);
	assert.equal(report.assessed, false);
	assert.equal(report.transition, "none");
	assert.equal(report.lines.find((l) => l.label === "Acceptance")!.ok, undefined);
});

test("finish: the acceptance assessment must be the owner's", () => {
	const fromSam = { ...final(2), author: "Sam" };
	assert.equal(finish([checkpointComment(1), fromSam]).assessed, false);
	assert.equal(finish([checkpointComment(1), { ...final(2), author: undefined as unknown as string }]).assessed, false);
	// Checks recorded by a previous owner at this commit remain valid evidence.
	assert.deepEqual(failed(finish([{ ...checkpointComment(1), author: "Sam" }, final(2)])), []);
});

test("finish: unmet acceptance in the final checkpoint blocks done", () => {
	const report = finish([checkpointComment(1), final(2, ["R2 live gate"])]);
	assert.deepEqual(failed(report), ["Acceptance"]);
	assert.equal(report.transition, "none");
});

test("finish: a final checkpoint from an older commit does not count", () => {
	const report = finish([checkpointComment(1), { ...final(2), body: final(2).body.replace(HEAD.slice(0, 12), "b".repeat(12)) }]);
	assert.equal(report.assessed, false);
});

test("finish: checks are the latest result per command across checkpoints", () => {
	const failing = checkpointComment(1, { checks: [{ ...PASS, result: "fail" }] });
	assert.deepEqual(failed(finish([failing])), ["Checks"]);
	assert.deepEqual(failed(finish([failing, checkpointComment(2)])), []);
	assert.deepEqual(failed(finish([checkpointComment(1), final(2)])), [], "a later checkpoint without checks keeps earlier evidence");
});

test("finish: stale, dirty-tree or missing checks block done; skipped ones need judgement", () => {
	assert.deepEqual(failed(finish([checkpointComment(1, { checks: [{ ...PASS, commit: "b".repeat(40) }] })])), ["Checks"]);
	assert.deepEqual(failed(finish([checkpointComment(1, { checks: [{ ...PASS, dirty: true }] })])), ["Checks"]);
	assert.deepEqual(failed(finish([checkpointComment(1, { checks: [] })])), ["Checks"]);
	const skipped = finish([checkpointComment(1, { checks: [PASS, { command: "e2e", result: "skipped", scope: "simulated", commit: HEAD }] }), final(2)]);
	assert.deepEqual(failed(skipped), []);
	assert.deepEqual(skipped.lines.filter((l) => l.ok === undefined).map((l) => l.label), ["Checks not run"]);
	assert.deepEqual(failed(finish([checkpointComment(1, { checks: [{ command: "e2e", result: "unavailable", scope: "live", commit: HEAD }] })])), ["Checks"]);
});

test("finish: an open reviewed-ready PR offers In Review; a draft or failing local state does not", () => {
	const report = finish([checkpointComment(1)], { pr: openPr });
	assert.deepEqual(failed(report).sort(), ["Human review", "Integrated"]);
	assert.equal(report.transition, "inReview");
	assert.equal(finish([checkpointComment(1)], { pr: { ...openPr, isDraft: true } }).transition, "none");
	assert.equal(finish([checkpointComment(1)], { pr: openPr, inProgress: false }).transition, "none");
	assert.equal(finish([checkpointComment(1)], { pr: openPr, review: undefined }).transition, "none");
	assert.match(formatFinish("ENG-1", report), /NOT DONE: 2 unmet/);
	// An unmet live gate blocks Done but not review of the source change.
	const liveGate = finish([checkpointComment(1), final(2, ["Live staging evidence"])], { pr: openPr });
	assert.equal(liveGate.transition, "inReview");
	assert.equal(finish([checkpointComment(1), final(2, ["Live staging evidence"])]).transition, "none");
});

test("finish: human review must come from someone other than the author", () => {
	const self = { ...mergedPr, reviewDecision: null, latestReviews: [{ author: { login: "dan" }, state: "APPROVED" }] };
	assert.deepEqual(failed(finish([checkpointComment(1)], { pr: self })), ["Human review"]);
	const other = { ...mergedPr, reviewDecision: null };
	assert.deepEqual(failed(finish([checkpointComment(1)], { pr: other })), []);
	const changes = { ...mergedPr, reviewDecision: null, latestReviews: [...mergedPr.latestReviews!, { author: { login: "ana" }, state: "CHANGES_REQUESTED" }] };
	assert.deepEqual(failed(finish([checkpointComment(1)], { pr: changes })), ["Human review"]);
});

test("finish: PR head, pending remote checks, stale or negative review block done", () => {
	const pr = { ...openPr, headRefOid: "c".repeat(40), statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }] };
	const report = finish([checkpointComment(1)], { pr, review: { commit: "d".repeat(40), verdict: "READY FOR HUMAN REVIEW" } });
	assert.deepEqual(failed(report).sort(), ["Agent review", "Human review", "Integrated", "PR head", "Remote checks"]);
	assert.match(report.lines.find((l) => l.label === "Remote checks")!.detail, /ci: IN_PROGRESS/);
	assert.deepEqual(failed(finish([checkpointComment(1)], { review: { commit: HEAD, verdict: "CHANGES NEEDED" } })), ["Agent review"]);
});

test("finish: dirty or unpushed work, a missing PR and open prerequisites block done", () => {
	const report = finish([checkpointComment(1)], {
		pr: undefined,
		git: { ...clean, changed: ["a"], upstream: undefined, unpushed: undefined },
		issue: issue("ENG-1", { comments: [checkpointComment(1)], labels: ["blocked"], blockers: [ref("ENG-0", { state: STATES.ready })], assignee: { id: "u-dan", name: "Dan" } }),
	});
	assert.deepEqual(failed(report).sort(), ["Local state", "Prerequisites", "Pull request"]);
	assert.match(report.lines.find((l) => l.label === "Local state")!.detail, /1 uncommitted file\(s\), commits not pushed/);
	// When GitHub cannot be queried, review and merge are unconfirmed: that is unmet, and Done is not offered.
	const unreachable = finish([checkpointComment(1), final(2)], { pr: undefined, prError: "gh: not logged in" });
	assert.deepEqual(failed(unreachable), ["Pull request"]);
	assert.match(unreachable.lines.find((l) => l.label === "Pull request")!.detail, /Could not query GitHub \(gh: not logged in\)/);
	assert.equal(unreachable.transition, "none");
	// A merged PR whose branch was deleted remotely still counts as pushed.
	assert.deepEqual(failed(finish([checkpointComment(1)], { git: { ...clean, upstream: undefined, unpushed: undefined } })), []);
});

const slice = (key: string, patch: Partial<ProposedSlice> = {}): ProposedSlice => ({
	key,
	title: key,
	acceptance: "a",
	requirements: ["R1"],
	repo: "acme-app",
	surfaces: [],
	verification: "v",
	dependsOn: [],
	...patch,
});

test("planning reuses issues with the same slice key", () => {
	const plan = reconcileSlices(
		[slice("x/a"), slice("x/b", { requirements: ["R2"], dependsOn: ["x/a"] })],
		[{ issue: ref("ENG-10"), slice: "x/a" }],
		["R1", "R2", "R3"],
	);
	assert.deepEqual(plan.errors, []);
	assert.deepEqual(plan.reuse.map((r) => [r.slice.key, r.issue.identifier]), [["x/a", "ENG-10"]]);
	assert.deepEqual(plan.create.map((s) => s.key), ["x/b"]);
	assert.deepEqual(plan.warnings, ["Requirements with no slice: R3"]);
});

test("planning dependencies must be slices of the same plan", () => {
	// Even a slice that already exists in Linear cannot be depended on unless it is part of this plan.
	const plan = reconcileSlices([slice("x/b", { dependsOn: ["x/a"] })], [{ issue: ref("ENG-10"), slice: "x/a" }], ["R1"]);
	assert.match(plan.errors.join("\n"), /x\/b depends on x\/a, which is not a slice of this plan/);
	assert.match(reconcileSlices([slice("x/a", { dependsOn: ["x/a"] })], [], ["R1"]).errors.join("\n"), /depends on itself/);
});

test("planning rejects cycles and keys that would not read back from Markdown", () => {
	const cyclic = reconcileSlices([slice("x/a", { dependsOn: ["x/c"] }), slice("x/b", { dependsOn: ["x/a"] }), slice("x/c", { dependsOn: ["x/b"] })], [], ["R1"]);
	assert.match(cyclic.errors.join("\n"), /Dependency cycle: x\/a → x\/c → x\/b → x\/a/);
	assert.deepEqual(reconcileSlices([slice("x/a"), slice("x/b", { dependsOn: ["x/a"] }), slice("x/c", { dependsOn: ["x/a", "x/b"] })], [], ["R1"]).errors, []);
	for (const key of ["x/`a`", "has space", "", "-leading"]) {
		assert.match(reconcileSlices([slice(key)], [], ["R1"]).errors.join("\n"), /may only contain/, key);
	}
});

test("planning rejects duplicate keys, unknown requirements and dangling dependencies", () => {
	const plan = reconcileSlices([slice("x/a"), slice("x/a", { requirements: ["R9"], dependsOn: ["x/zzz"] }), slice("x/c", { requirements: [] })], [], ["R1"]);
	const text = plan.errors.join("\n");
	assert.match(text, /Duplicate slice key x\/a/);
	assert.match(text, /not in the spec: R9/);
	assert.match(text, /depends on x\/zzz, which is not a slice of this plan/);
	assert.match(text, /x\/c references no requirements/);
});
