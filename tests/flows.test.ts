import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatCheckpoint } from "../src/checkpoint.ts";
import { USERS } from "./fake-linear.ts";
import { git, profiledRepo, tempDir, write } from "./helpers.ts";
import { host, withGh, withLinear } from "./host.ts";

// Whole command flows, in process: real git in temporary repositories, a fake Linear and a fake gh.

const checkpoint = (issue: string, head: string, patch: Record<string, unknown> = {}) =>
	formatCheckpoint({
		id: `cp-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`,
		kind: "progress",
		issue,
		owner: "Dan",
		spec: "direct acceptance in the issue",
		commit: head,
		done: ["Everything"],
		remaining: [],
		checks: [{ command: "./scripts/verify --offline", result: "pass", scope: "local", commit: head }],
		next: "Review",
		unsynced: [],
		...patch,
	});

async function session(root: string) {
	const h = host(root);
	await h.emit("session_start", { type: "session_start", reason: "startup" });
	const work = (args: string) => h.commands.get("work")!.handler(args, h.ctx);
	const report = () => h.messages.map((m) => String(m.content)).join("\n");
	return { h, work, report };
}

// An issue branch with one pushed commit, and the PR that carries it.
function featureBranch(root: string, key: string) {
	const branch = `linear/${key}-feature`;
	git(root, "switch", "-qc", branch, "main");
	write(root, `${key}.txt`, "done\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", `${key} feature`);
	git(root, "push", "-q", "-u", "origin", branch);
	const head = git(root, "rev-parse", "HEAD");
	const pr = { number: 7, url: "https://github.example/pr/7", state: "OPEN", isDraft: false, headRefName: branch, headRefOid: head, baseRefName: "main", reviewDecision: "", mergedAt: null, author: { login: "dan" }, latestReviews: [] as unknown[], statusCheckRollup: [] };
	return { branch, head, pr };
}

test("finish reaches Done from the default branch after a squash merge deleted the issue branch", async () => {
	await withLinear(async (linear) => {
		await withGh(async (gh) => {
			const { root } = profiledRepo();
			const { branch, head, pr } = featureBranch(root, "ENG-70");
			linear.add("ENG-70", { assignee: USERS.dan.id, state: "In Review" });
			linear.comment("ENG-70", checkpoint("ENG-70", head, { branch }));
			linear.comment("ENG-70", checkpoint("ENG-70", head, { branch, kind: "final", checks: [] }));
			write(root, ".git/pi-team/reviews/ENG-70.json", JSON.stringify({ issue: "ENG-70", commit: head, verdict: "READY FOR HUMAN REVIEW", at: "t" }));

			// What `gh pr merge --squash --delete-branch` leaves behind: a new commit on main, no branch anywhere.
			git(root, "switch", "-q", "main");
			write(root, "ENG-70.txt", "done\n");
			git(root, "add", "-A");
			git(root, "commit", "-qm", "ENG-70 feature (#7)");
			git(root, "push", "-q", "origin", "main");
			git(root, "push", "-q", "origin", "--delete", branch);
			git(root, "branch", "-qD", branch);
			git(root, "fetch", "-q", "--prune", "origin");
			gh.setPr({ ...pr, state: "MERGED", mergedAt: "2026-10-02", latestReviews: [{ author: { login: "sam" }, state: "APPROVED" }] });

			const { h, work, report } = await session(root);
			await work("finish ENG-70");
			assert.equal(h.confirms.at(-1)?.title, "Complete ENG-70?");
			assert.match(report(), new RegExp(`✓ Checks: 1 passing at the merged commit ${head.slice(0, 12)}`));
			assert.match(report(), /✓ Local state: Nothing local beyond what was merged/);
			assert.match(report(), /Moved ENG-70 to Done/);
			assert.equal(linear.get("ENG-70").state, "Done");
		});
	});
});

test("an assessment requested after the merge is recorded against the merged commit, not the default branch", async () => {
	await withLinear(async (linear) => {
		await withGh(async (gh) => {
			const { root } = profiledRepo();
			const { branch, head, pr } = featureBranch(root, "ENG-71");
			linear.add("ENG-71", { assignee: USERS.dan.id, state: "In Review" });
			linear.comment("ENG-71", checkpoint("ENG-71", head, { branch }));
			write(root, ".git/pi-team/reviews/ENG-71.json", JSON.stringify({ issue: "ENG-71", commit: head, verdict: "READY FOR HUMAN REVIEW", at: "t" }));
			git(root, "switch", "-q", "main");
			git(root, "merge", "-q", "--no-ff", "-m", "Merge ENG-71", branch);
			git(root, "push", "-q", "origin", "main");
			gh.setPr({ ...pr, state: "MERGED", mergedAt: "2026-10-02", latestReviews: [{ author: { login: "sam" }, state: "APPROVED" }] });

			const { h, work, report } = await session(root);
			await work("finish ENG-71");
			assert.match(report(), /\? Acceptance: Not yet assessed at the merged commit/);
			assert.match(h.userMessages.at(-1)!, /Assess ENG-71 against its acceptance/);
			assert.equal(h.confirms.length, 0, "nothing is offered before the assessment");

			// The agent's final checkpoint, posted from main, is stamped with the commit under judgement.
			const result = await h.tools.get("team_checkpoint").execute("c", { kind: "final", done: ["All items met"], remaining: [], checks: [], next: "Close" }, undefined, undefined, h.ctx);
			assert.equal(result.isError, undefined, result.content[0].text);
			const posted = linear.get("ENG-71").comments.at(-1)!.body;
			assert.match(posted, new RegExp(`\\*\\*Branch:\\*\\* \`${branch}\` · \\*\\*Commit:\\*\\* \`${head.slice(0, 12)}\``));

			await work("finish ENG-71");
			assert.equal(h.confirms.at(-1)?.title, "Complete ENG-71?");
			assert.equal(linear.get("ENG-71").state, "Done");
		});
	});
});

test("finish names what is missing when run from a checkout with no PR for the issue", async () => {
	await withLinear(async (linear) => {
		await withGh(async () => {
			const { root } = profiledRepo();
			linear.add("ENG-72", { assignee: USERS.dan.id, state: "In Progress" });
			const { work, report, h } = await session(root);
			await work("finish ENG-72");
			assert.match(report(), /✗ Pull request: None found for this issue's branch/);
			assert.match(report(), /No pull request was found for this issue\. Run \/work finish from the issue's branch/);
			assert.equal(h.userMessages.length, 0);
		});
	});
});

test("a checkpoint is refused when the checkout is on another issue's branch", async () => {
	await withLinear(async (linear) => {
		await withGh(async () => {
			const { root } = profiledRepo();
			linear.add("ENG-12", { assignee: USERS.dan.id, state: "In Progress" });
			linear.add("ENG-13", { assignee: USERS.dan.id, state: "In Progress" });
			git(root, "switch", "-qc", "linear/ENG-12-a");
			const { h } = await session(root);
			git(root, "switch", "-qc", "linear/ENG-13-b");
			const params = { kind: "progress", done: [], remaining: [], checks: [], next: "n" };
			await assert.rejects(h.tools.get("team_checkpoint").execute("c", params, undefined, undefined, h.ctx), /is on linear\/ENG-13-b, which belongs to ENG-13/);
			assert.equal(linear.get("ENG-12").comments.length, 0);
			// Naming the issue the branch belongs to works.
			assert.equal((await h.tools.get("team_checkpoint").execute("c", { ...params, issue: "ENG-13" }, undefined, undefined, h.ctx)).isError, undefined);
			assert.equal(linear.get("ENG-13").comments.length, 1);
		});
	});
});

test("start brings Linear up to date when the branch already has a worktree, so a failed start can be rerun", async () => {
	await withLinear(async (linear) => {
		await withGh(async () => {
			const { root } = profiledRepo();
			linear.add("ENG-40", { title: "Worktree slice" });
			const { h, work, report } = await session(root);
			h.answers.select = (options) => options.find((o) => o.startsWith("Create worktree"));

			// First attempt: the worktree is created, then Linear fails.
			linear.failNext = { match: "issueUpdate", mode: "network" };
			await work("start ENG-40");
			assert.match(h.notices.at(-1)!, /\/work start: Linear request failed/);
			const dir = h.selects[0].options.find((o) => o.startsWith("Create worktree"))!.replace("Create worktree ", "");
			assert.ok(existsSync(join(dir, "README.md")));
			assert.equal(linear.get("ENG-40").assignee, undefined);
			assert.equal(linear.get("ENG-40").state, "Ready");

			// Second attempt: no second worktree; ownership, state and the start checkpoint are recorded.
			await work("start ENG-40");
			assert.equal(h.selects.length, 1, "the existing worktree is used without asking again");
			assert.equal(linear.get("ENG-40").assignee, USERS.dan.id);
			assert.equal(linear.get("ENG-40").state, "In Progress");
			assert.match(linear.get("ENG-40").comments[0].body, /\(start\)[\s\S]*\*\*Branch:\*\* `linear\/ENG-40-worktree-slice`/);
			assert.match(report(), /linear\/ENG-40-worktree-slice is already checked out at .*\nContinue there: cd /);
		});
	});
});

test("start prefers the issue branch this checkout is already on", async () => {
	await withLinear(async (linear) => {
		await withGh(async () => {
			const { root } = profiledRepo();
			linear.add("ENG-42", { assignee: USERS.dan.id });
			git(root, "branch", "backup/ENG-42-old");
			git(root, "switch", "-qc", "linear/ENG-42-new");
			const { h, work } = await session(root);
			await work("start ENG-42");
			assert.equal(h.selects.length, 0, "already on a branch for this issue: nothing to choose");
			assert.equal(git(root, "branch", "--show-current"), "linear/ENG-42-new");
			assert.match(linear.get("ENG-42").comments[0].body, /\*\*Branch:\*\* `linear\/ENG-42-new`/);
		});
	});
});

test("a session restored in spec or review mode gets that mode's reasoning level back", async () => {
	const h = host(tempDir());
	h.entries.push({ type: "custom", customType: "pi-team-state", data: { mode: "review" } });
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.deepEqual(h.thinking, ["high"]);
	const fresh = host(tempDir());
	await fresh.emit("session_start", { type: "session_start", reason: "startup" });
	assert.deepEqual(fresh.thinking, []);
});

test("push publishes the owner's issue branch from the host and opens a draft PR once", async () => {
	await withLinear(async (linear) => {
		await withGh(async (gh) => {
			const { root, origin } = profiledRepo();
			linear.add("ENG-80", { assignee: USERS.dan.id, state: "In Progress", title: "Publishable", description: "1. It works.\n\n---\n**pi-team**\n- repo: `foundations-idp`" });
			git(root, "switch", "-qc", "linear/ENG-80-publishable", "--no-track", "origin/main");
			write(root, "feature.txt", "x\n");
			git(root, "add", "-A");
			git(root, "commit", "-qm", "ENG-80");
			write(root, "scratch.txt", "not committed\n");
			const head = git(root, "rev-parse", "HEAD");
			const { h, work, report } = await session(root);

			h.answers.confirm = false;
			await work("push");
			assert.match(h.confirms[0].message, /Push linear\/ENG-80-publishable \(1 commit\(s\) beyond origin\/main\) to origin and open a draft pull request\.\n1 uncommitted file\(s\) are not included\./);
			assert.equal(git(origin, "branch", "--list", "linear/ENG-80-publishable"), "", "declining pushes nothing");

			h.answers.confirm = true;
			await work("push");
			assert.equal(git(origin, "rev-parse", "linear/ENG-80-publishable"), head);
			assert.equal(git(root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/linear/ENG-80-publishable");
			const args = gh.created()!;
			assert.deepEqual(args.slice(0, 9), ["pr", "create", "--draft", "--head", "linear/ENG-80-publishable", "--base", "main", "--title", "ENG-80: Publishable"]);
			assert.match(args.join("\n"), /## Acceptance\n1\. It works\./);
			assert.doesNotMatch(args.join("\n"), /pi-team/, "the planning footer is not copied into the PR");
			assert.match(report(), /Pushed linear\/ENG-80-publishable at [0-9a-f]{12} to origin\.\nOpened draft PR: https:\/\/github\.example\/pr\/99\n1 uncommitted file/);

			// With the PR open, a later push only pushes.
			gh.setPr({ number: 99, url: "https://github.example/pr/99", state: "OPEN", isDraft: true, headRefName: "linear/ENG-80-publishable", headRefOid: head, baseRefName: "main", reviewDecision: "", mergedAt: null });
			git(root, "commit", "-qam", "more", "--allow-empty");
			h.confirms.length = 0;
			await work("push");
			assert.match(h.confirms[0].message, /PR #99 is already open/);
			assert.equal(git(origin, "rev-parse", "linear/ENG-80-publishable"), git(root, "rev-parse", "HEAD"));
		});
	});
});

test("push refuses the default branch, someone else's issue, another issue's branch and an unreachable GitHub", async () => {
	await withLinear(async (linear) => {
		await withGh(async (gh) => {
			const { root, origin } = profiledRepo();
			linear.add("ENG-81", { assignee: USERS.sam.id, state: "In Progress" });
			linear.add("ENG-82", { assignee: USERS.dan.id, state: "In Progress" });
			const { h, work } = await session(root);
			const refused = async (pattern: RegExp) => {
				await work("push");
				assert.match(h.notices.at(-1)!, pattern);
			};

			h.pi.appendEntry("pi-team-state", { issue: "ENG-82", mode: "implement" });
			await h.emit("session_tree", {});
			await refused(/publishes issue branches, not main/);

			git(root, "switch", "-qc", "linear/ENG-81-theirs");
			git(root, "commit", "-qm", "x", "--allow-empty");
			await refused(/which is not ENG-82's branch/);

			h.pi.appendEntry("pi-team-state", { issue: "ENG-81", mode: "implement" });
			await h.emit("session_tree", {});
			await refused(/ENG-81 is not assigned to you/);

			git(root, "switch", "-qc", "linear/ENG-82-mine", "main");
			h.pi.appendEntry("pi-team-state", { issue: "ENG-82", mode: "implement" });
			await h.emit("session_tree", {});
			await refused(/has no commits beyond origin\/main/);

			git(root, "commit", "-qm", "work", "--allow-empty");
			gh.fail();
			await refused(/Could not query GitHub .* nothing was pushed/);
			assert.equal(git(origin, "branch", "--list", "linear/*"), "");
			assert.equal(h.confirms.length, 0);
		});
	});
});
