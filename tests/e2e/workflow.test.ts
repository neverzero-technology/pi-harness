import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { formatCheckpoint } from "../../src/checkpoint.ts";
import { USERS } from "../fake-linear.ts";
import { git, write } from "../helpers.ts";
import { type Fixture, fixture } from "./driver.ts";

// Real Pi, real git, fake Linear and fake gh. Run with PI_TEAM_E2E=1 on a machine with Pi installed.
const enabled = process.env.PI_TEAM_E2E === "1";

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

describe("pi-team under a real Pi host", { skip: !enabled && "set PI_TEAM_E2E=1" }, () => {
	let f: Fixture;
	before(async () => {
		f = await fixture();
	});
	after(async () => {
		await f?.close();
	});
	afterEach(async () => { await f?.closeSessions(); });

	test("repository shell commands run in Gondolin without host credentials", async () => {
		const s = f.session();
		const result = await s.bash('uname -s; test -z "$LINEAR_API_KEY" && echo NO_HOST_KEY; pwd');
		assert.equal(result.exitCode, 0);
		assert.match(result.output, /Linux/);
		assert.match(result.output, /NO_HOST_KEY/);
		assert.match(result.output, /\/workspace/);
	});

	test("doctor passes against a configured workspace", async () => {
		const s = f.session();
		const { messages, modelTurns } = await s.run("/team doctor");
		const report = messages.join("\n");
		for (const expected of [
			"✓ Package: @neverzero/pi-team",
			"✓ Pi host: 0.99.2",
			"✓ Launcher: pi-team",
			"✓ Sandbox: Gondolin VM ready",
			"profile foundations-idp",
			"✓ Linear identity: Dan <dan@example.test> via LINEAR_API_KEY",
			"✓ Workflow states: All mapped",
			"✓ Label: blocked",
			"✓ Label: repo:foundations-idp",
			"✓ GitHub CLI",
			"✓ Other tools: none",
		]) {
			assert.ok(report.includes(expected), `${expected}\n---\n${report}`);
		}
		assert.match(report, /! Model: openai\/gpt-4o-mini/, "a non-team model is flagged");
		assert.equal(modelTurns, 0);
	});

	test("doctor names what is missing in a misconfigured workspace", async () => {
		f.linear.labels = ["repo:foundations-idp"];
		f.linear.team.key = "OPS";
		const report = (await f.session().run("/team doctor")).messages.join("\n");
		f.linear.team.key = "ENG";
		f.linear.labels = ["blocked", "repo:foundations", "repo:foundations-idp", "repo:migratory"];
		assert.match(report, /✗ Linear team: No team with key ENG/);
	});

	test("next recommends without claiming", async () => {
		f.linear.add("ENG-10", { assignee: USERS.dan.id, title: "Mine and ready" });
		f.linear.add("ENG-11", { labels: ["repo:foundations-idp"], title: "Unassigned here" });
		f.linear.add("ENG-12", { labels: ["repo:migratory"], title: "Unassigned elsewhere" });
		f.linear.add("ENG-13", { labels: ["repo:foundations-idp"], title: "Waiting" });
		f.linear.blocks("ENG-10", "ENG-13");
		const out = (await f.session().run("/work next")).messages.join("\n");
		assert.match(out, /Assigned to you:\n- ENG-10 Mine and ready/);
		assert.match(out, /Unassigned Ready \(repo:foundations-idp\):\n- ENG-11 Unassigned here/);
		assert.match(out, /Waiting on prerequisites:\n- ENG-13 .*waiting on ENG-10/);
		assert.doesNotMatch(out, /ENG-12/);
		assert.equal(f.linear.get("ENG-11").assignee, undefined);
	});

	test("start refuses another person's issue and changes nothing", async () => {
		f.linear.add("ENG-20", { assignee: USERS.sam.id });
		const { messages, dialogs } = await f.session().run("/work start ENG-20");
		assert.match(messages.join("\n"), /Refused:\n- ENG-20 is assigned to Sam/);
		assert.equal(dialogs.length, 0);
		assert.equal(f.linear.get("ENG-20").state, "Ready");
		assert.equal(f.linear.get("ENG-20").comments.length, 0);
		assert.equal(git(f.root, "branch", "--show-current"), "main");
	});

	test("declining a confirmation changes nothing", async () => {
		f.linear.add("ENG-21");
		const { dialogs, notices } = await f.session().run("/work start ENG-21", () => false);
		assert.match(dialogs[0].message ?? "", /unassigned; assign it to you/);
		assert.match(notices.join("\n"), /nothing was changed/);
		assert.equal(f.linear.get("ENG-21").assignee, undefined);
		assert.equal(git(f.root, "branch", "--list", "*ENG-21*"), "");
	});

	test("start claims an unassigned issue, branches, moves it and briefs the session", async () => {
		f.linear.add("ENG-30", { title: "Tenant resolution", description: "Reject conflicting tenant input." });
		const s = f.session();
		const { messages, dialogs } = await s.run("/work start ENG-30", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true));
		assert.deepEqual(dialogs.map((d) => d.method), ["confirm", "select"]);
		assert.equal(git(f.root, "branch", "--show-current"), "linear/ENG-30-tenant-resolution");
		const issue = f.linear.get("ENG-30");
		assert.equal(issue.assignee, USERS.dan.id);
		assert.equal(issue.state, "In Progress");
		assert.match(issue.comments[0].body, /pi-team checkpoint `cp-[0-9a-f]{8}` \(start\)/);
		assert.match(issue.comments[0].body, /\*\*Branch:\*\* `linear\/ENG-30-tenant-resolution`/);
		const out = messages.join("\n");
		assert.match(out, /Checkpoint cp-[0-9a-f]{8} stored on ENG-30\. Moved to In Progress\./);
		assert.match(out, /## Acceptance\nReject conflicting tenant input\./);
		assert.match(out, /Tenancy \(namespace, repository, RepoSync\) comes from the tenant System entity/);
		assert.match(out, /Offline gate: `\.\/scripts\/verify --offline`/);
		assert.equal(s.status["pi-team"], "foundations-idp · ENG-30 · implement");

		const status = (await s.run("/work status")).messages.join("\n");
		assert.match(status, /Session: ENG-30 · mode implement · profile foundations-idp/);
		assert.match(status, /Branch: linear\/ENG-30-tenant-resolution @ [0-9a-f]{12} · branch not pushed/, "a new branch does not count as pushed via origin/main");
		assert.match(issue.comments[0].body, /\*\*Unsynced local state:\*\* branch not pushed/);

		// Starting it again continues; it does not post another blank checkpoint.
		const again = (await f.session().run("/work start ENG-30")).messages.join("\n");
		assert.match(again, /Continuing from checkpoint cp-[0-9a-f]{8} \(start\)/);
		assert.equal(issue.comments.length, 1);

		// A key from another team, or a typo, is an error rather than "the current issue".
		const typo = await s.run("/work finish OPS-30");
		assert.match(typo.notices.join("\n"), /"OPS-30" is not a ENG issue key/);
		assert.equal(typo.messages.length, 0);
		assert.match(status, /Linear: In Progress · Dan/);
		assert.match(status, /Latest checkpoint: cp-[0-9a-f]{8} \(start\)/);

		// A second active issue is an explicit exception.
		f.linear.add("ENG-31", { assignee: USERS.dan.id });
		const second = await f.session().run("/work start ENG-31", () => false);
		assert.match(second.dialogs[0].message ?? "", /already have active work: ENG-30 \(In Progress\)/);
		git(f.root, "switch", "-q", "main");
	});

	test("block and unblock keep the workflow state and leave a visible trail", async () => {
		const s = f.session();
		await s.run("/work resume ENG-30");
		await s.run("/work block waiting on the Foundations 0.2 release, token=abc123def456ghi789");
		const issue = f.linear.get("ENG-30");
		assert.deepEqual(issue.labels, ["blocked"]);
		assert.equal(issue.state, "In Progress");
		assert.match(issue.comments.at(-1)!.body, /\*\*Blocked\*\* \(pi-team\): waiting on the Foundations 0\.2 release, token=\[redacted\]/);
		await s.run("/work block --clear released");
		assert.deepEqual(issue.labels, []);
		assert.match(issue.comments.at(-1)!.body, /\*\*Unblocked\*\* \(pi-team\): released/);
	});

	test("a dirty checkout is left alone and the work goes to a worktree", async () => {
		f.linear.add("ENG-40", { assignee: USERS.dan.id, title: "Worktree slice" });
		f.linear.get("ENG-30").state = "In Review";
		write(f.root, "scratch.txt", "someone's uncommitted work\n");
		const { dialogs, messages } = await f.session().run("/work start ENG-40", (d) => (d.method === "select" ? d.options![0] : true));
		const select = dialogs.find((d) => d.method === "select")!;
		assert.match(select.title, /uncommitted work, which will be left alone/);
		assert.equal(select.options!.length, 2, "only worktree or cancel when dirty");
		const dir = select.options![0].replace("Create worktree ", "");
		assert.ok(existsSync(join(dir, "README.md")));
		assert.equal(git(dir, "branch", "--show-current"), "linear/ENG-40-worktree-slice");
		assert.equal(git(f.root, "branch", "--show-current"), "main");
		assert.ok(existsSync(join(f.root, "scratch.txt")));
		assert.match(f.linear.get("ENG-40").comments[0].body, /\*\*Branch:\*\* `linear\/ENG-40-worktree-slice`/);
		assert.match(messages.join("\n"), /Continue there: cd .* && pi-team, then \/work resume ENG-40/);

		// Starting it again points at the existing worktree instead of making another.
		const again = (await f.session().run("/work start ENG-40")).messages.join("\n");
		assert.match(again, /already checked out at .*linear-ENG-40-worktree-slice/);

		// A session in the worktree resumes with full context and shares pending state with the main checkout.
		const inWorktree = f.session(dir);
		const resumed = (await inWorktree.run("/work resume")).messages.join("\n");
		assert.match(resumed, /Latest checkpoint cp-[0-9a-f]{8} \(start\) by Dan/);
		assert.equal(inWorktree.status["pi-team"], "foundations-idp · ENG-40 · implement");
		git(f.root, "worktree", "remove", "--force", dir);
		f.linear.get("ENG-40").state = "Canceled";
	});

	test("a lost or failed checkpoint is never reported as synced, and resume reconciles it", async () => {
		git(f.root, "stash", "-u", "-q");
		f.linear.add("ENG-50", { assignee: USERS.dan.id, title: "Lost write" });
		f.linear.failNext = { match: "commentCreate", mode: "lost" };
		const s = f.session();
		const started = (await s.run("/work start ENG-50", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true))).messages.join("\n");
		assert.match(started, /Shared progress is NOT confirmed/);
		assert.match(started, /may or may not have been stored/);
		const pendingDir = join(f.root, ".git", "pi-team", "pending");
		assert.deepEqual(readdirSync(pendingDir), ["ENG-50.json"]);
		assert.match(s.status["pi-team-sync"] ?? "", /NOT synced/);

		const lost = await f.session().run("/work resume ENG-50");
		assert.match(lost.messages.join("\n"), /Pending checkpoint cp-[0-9a-f]{8} had been stored; cleared the local copy/);
		assert.equal(lost.dialogs.length, 0, "no repost when the write had landed");
		assert.deepEqual(readdirSync(pendingDir), []);
		assert.equal(f.linear.get("ENG-50").comments.length, 1);

		// A write that never arrived is offered for posting.
		git(f.root, "switch", "-q", "main");
		f.linear.add("ENG-51", { assignee: USERS.dan.id, title: "Failed write" });
		f.linear.get("ENG-50").state = "Done";
		f.linear.failNext = { match: "commentCreate", mode: "network" };
		await f.session().run("/work start ENG-51", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true));
		assert.equal(f.linear.get("ENG-51").comments.length, 0);
		const fresh = f.session();
		const warned = await fresh.run("/work status");
		assert.match(warned.messages.join("\n"), /Unsynced checkpoints: ENG-51 cp-/);
		const reposted = await fresh.run("/work resume ENG-51");
		assert.equal(reposted.dialogs[0].title, "Post unsynced checkpoint?");
		assert.match(reposted.messages.join("\n"), /Posted cp-/);
		assert.equal(f.linear.get("ENG-51").comments.length, 1);
		assert.deepEqual(readdirSync(pendingDir), []);
		f.linear.get("ENG-51").state = "Done";
		git(f.root, "switch", "-q", "main");
	});

	test("Linear being down blocks claims but not local visibility", async () => {
		f.linear.add("ENG-55", { assignee: USERS.dan.id });
		const s = f.session();
		await s.run("/work resume ENG-55");
		const realTeam = f.linear.viewer;
		// Simulate an outage: the fake rejects the key.
		const handle = f.linear.handle.bind(f.linear);
		f.linear.handle = () => {
			throw new Error("outage");
		};
		try {
			const fresh = f.session();
			const start = await fresh.run("/work start ENG-55");
			assert.match(start.notices.join("\n"), /\/work start: Linear request failed|Linear HTTP/);
			const status = (await fresh.run("/work status ENG-55")).messages.join("\n");
			assert.match(status, /Linear unavailable: .*Showing local state only; shared state is unconfirmed/);
			const resume = (await fresh.run("/work resume ENG-55")).messages.join("\n");
			assert.match(resume, /Shared state is stale: do not claim ownership/);
		} finally {
			f.linear.handle = handle;
			f.linear.viewer = realTeam;
			f.linear.get("ENG-55").state = "Done";
		}
	});

	test("a handoff carries the previous owner's remaining work forward", async () => {
		f.linear.add("ENG-65", { assignee: USERS.dan.id, state: "In Progress", title: "Handed over" });
		f.linear.comment(
			"ENG-65",
			checkpoint("ENG-65", "a".repeat(40), { kind: "handoff", owner: "Sam", done: ["R1 resolution"], remaining: ["R2 audit", "R3 docs"], next: "Write the audit test", checks: [] }),
			USERS.sam.id,
		);
		const s = f.session();
		const out = (await s.run("/work start ENG-65", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true))).messages.join("\n");
		assert.match(out, /Last checkpoint cp-[0-9a-f]{8} was written by Sam; this is a handoff/);
		const comments = f.linear.get("ENG-65").comments;
		assert.equal(comments.length, 2);
		assert.match(comments[1].body, /\(start\)/);
		assert.match(comments[1].body, /- Took over from Sam at checkpoint cp-[0-9a-f]{8}\n- R1 resolution/);
		assert.match(comments[1].body, /\*\*Remaining\*\*\n- R2 audit\n- R3 docs/);
		assert.match(comments[1].body, /\*\*Next:\*\* Write the audit test/);
		// The briefing shows the previous owner's checkpoint, not a blank one.
		assert.match(out, /## Latest checkpoint\n### pi-team checkpoint `cp-[0-9a-f]{8}` \(handoff\)/);
		f.linear.get("ENG-65").state = "Done";
		git(f.root, "switch", "-q", "main");
	});

	test("an issue in review is not pulled back without asking, and another repo's slice is refused", async () => {
		f.linear.add("ENG-66", { assignee: USERS.dan.id, state: "In Review" });
		const declined = await f.session().run("/work start ENG-66", () => false);
		assert.match(declined.dialogs[0].message ?? "", /is in In Review; starting work moves it back to In Progress/);
		assert.equal(f.linear.get("ENG-66").state, "In Review");
		f.linear.get("ENG-66").state = "Done";

		f.linear.add("ENG-67", { assignee: USERS.dan.id, description: "Do it.\n\n---\n**pi-team**\n- repo: `migratory`\n- slice: `x/a`\n- requirements: R1" });
		const wrongRepo = (await f.session().run("/work start ENG-67")).messages.join("\n");
		assert.match(wrongRepo, /Refused:\n- ENG-67 belongs to migratory, but this checkout is foundations-idp/);
		f.linear.get("ENG-67").state = "Done";
	});

	test("read-only assistance on someone else's issue", async () => {
		f.linear.add("ENG-60", { assignee: USERS.sam.id, state: "In Progress" });
		const s = f.session();
		const out = (await s.run("/work resume ENG-60")).messages.join("\n");
		assert.match(out, /Owned by Sam\. This session is read-only assistance \(review mode\)/);
		assert.equal(s.status["pi-team"], "foundations-idp · ENG-60 · review");
	});

	test("finish reports truthfully and only offers the transition the evidence supports", async () => {
		for (const done of ["ENG-30", "ENG-31", "ENG-10"]) f.linear.get(done).state = "Done";
		f.linear.add("ENG-70", { assignee: USERS.dan.id, title: "Finishable" });
		const s = f.session();
		await s.run("/work start ENG-70", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true));
		write(f.root, "feature.txt", "done\n");
		git(f.root, "add", "feature.txt");
		git(f.root, "commit", "-qm", "ENG-70 feature");
		const head = git(f.root, "rev-parse", "HEAD");
		const branch = git(f.root, "branch", "--show-current");

		// Nothing recorded yet: every gap is named, and no transition is offered.
		f.linear.comment("ENG-70", checkpoint("ENG-70", head, { kind: "final" }));
		const bare = await s.run("/work finish");
		const first = bare.messages.join("\n");
		assert.match(first, /NOT DONE/);
		assert.match(first, /✗ Agent review: Not run/);
		assert.match(first, /✗ Local state: commits not pushed/);
		assert.match(first, /✗ Pull request: None found/);
		assert.equal(bare.dialogs.length, 0);
		assert.equal(f.linear.get("ENG-70").state, "In Progress");

		// Pushed, agent-reviewed, PR open: In Review is offered; Done is not.
		git(f.root, "push", "-q", "-u", "origin", branch);
		write(f.root, ".git/pi-team/reviews/ENG-70.json", JSON.stringify({ issue: "ENG-70", commit: head, verdict: "READY FOR HUMAN REVIEW", at: "t" }));
		const pr = { number: 7, url: "https://github.example/pr/7", state: "OPEN", isDraft: false, headRefName: branch, headRefOid: head, baseRefName: "main", reviewDecision: "", mergedAt: null, author: { login: "dan" }, latestReviews: [], statusCheckRollup: [] };
		f.setPr(pr);
		const review = await s.run("/work finish");
		assert.equal(review.dialogs.length, 1);
		assert.equal(review.dialogs[0].title, "Move ENG-70 to In Review?");
		assert.equal(f.linear.get("ENG-70").state, "In Review");
		assert.match(review.messages.join("\n"), /✗ Human review: No approval from another person/);

		// If GitHub cannot be queried, nothing is offered and the gap is named.
		const ghScript = join(f.ghDir, "bin", "gh");
		const realGh = readFileSync(ghScript, "utf8");
		writeFileSync(ghScript, '#!/bin/sh\necho "gh: could not connect" >&2\nexit 1\n');
		const offline = await s.run("/work finish");
		writeFileSync(ghScript, realGh);
		assert.equal(offline.dialogs.length, 0);
		assert.match(offline.messages.join("\n"), /✗ Pull request: Could not query GitHub \(gh: could not connect\); review and merge are unconfirmed/);

		// Self-approval does not count.
		f.setPr({ ...pr, state: "MERGED", mergedAt: "2026-10-02", latestReviews: [{ author: { login: "dan" }, state: "APPROVED" }] });
		const selfApproved = await s.run("/work finish");
		assert.equal(selfApproved.dialogs.length, 0);
		assert.match(selfApproved.messages.join("\n"), /✗ Human review/);

		// Merged and approved by someone else: the human is asked, and may decline.
		f.setPr({ ...pr, state: "MERGED", mergedAt: "2026-10-02", latestReviews: [{ author: { login: "sam" }, state: "APPROVED" }] });
		const declined = await s.run("/work finish", () => false);
		assert.equal(declined.dialogs[0].title, "Complete ENG-70?");
		assert.match(declined.dialogs[0].message ?? "", /\? Remote checks: None reported/);
		assert.equal(f.linear.get("ENG-70").state, "In Review");
		const done = await s.run("/work finish");
		assert.match(done.messages.join("\n"), /Moved ENG-70 to Done/);
		assert.equal(f.linear.get("ENG-70").state, "Done");
		assert.equal(bare.modelTurns + review.modelTurns + done.modelTurns, 0, "an assessed issue needs no model turn");
		f.setPr(undefined);
		git(f.root, "switch", "-q", "main");
	});

	test("everything still parses after Linear normalises the Markdown", async () => {
		f.linear.normaliseMarkdown = true;
		try {
			f.linear.add("ENG-80", { assignee: USERS.dan.id, title: "Normalised" });
			const s = f.session();
			await s.run("/work start ENG-80", (d) => (d.method === "select" ? d.options!.find((o) => o.startsWith("Switch")) : true));
			assert.match(f.linear.get("ENG-80").comments[0].body, /^\* none$/m, "the fake rewrote the bullets");
			const resumed = (await f.session().run("/work resume ENG-80")).messages.join("\n");
			assert.match(resumed, /Latest checkpoint cp-[0-9a-f]{8} \(start\) by Dan/);
			assert.doesNotMatch(resumed, /Commits since checkpoint|differs from this checkout/);
		} finally {
			f.linear.normaliseMarkdown = false;
			git(f.root, "switch", "-q", "main");
		}
	});

	test("review runs a read-only reviewer on the exact change and records only clean, successful runs", async () => {
		f.linear.add("ENG-75", { assignee: USERS.dan.id, state: "In Progress", title: "Reviewable", description: "Feature file exists." });
		git(f.root, "switch", "-qc", "linear/ENG-75-reviewable", "main");
		write(f.root, "feature75.txt", "v1\n");
		git(f.root, "add", "-A");
		git(f.root, "commit", "-qm", "ENG-75");
		const head = git(f.root, "rev-parse", "HEAD");
		f.linear.comment("ENG-75", checkpoint("ENG-75", head));

		// A stand-in reviewer that records how it was invoked and what it was given.
		const capture = join(f.ghDir, "reviewer");
		const reviewer = join(f.ghDir, "bin", "reviewer");
		const script = (verdict: string, exit = 0) =>
			`#!/bin/sh\nif [ "$1" = "--help" ]; then echo --team-reviewer-sandbox; exit 0; fi\nmkdir -p "${capture}"\necho "$@" > "${capture}/args"\nfor a in "$@"; do case "$a" in @*) cp "\${a#@}" "${capture}/packet.md" ;; esac; done\n` +
			`printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","model":"fake-reviewer","content":[{"type":"text","text":"${verdict}"}]}}'\nexit ${exit}\n`;
		writeFileSync(reviewer, script("CHANGES NEEDED\\n\\n1. blocking: feature75.txt:1 is wrong"));
		chmodSync(reviewer, 0o755);
		process.env.PI_TEAM_REVIEWER_BIN = reviewer;
		f.setPr({ number: 9, title: "Other work", headRefName: "linear/ENG-99-other", files: [{ path: "feature75.txt" }, { path: "unrelated.txt" }] });
		const record = join(f.root, ".git", "pi-team", "reviews", "ENG-75.json");
		try {
			const s = f.session();
			const clean = (await s.run("/review")).messages.join("\n");
			assert.match(clean, new RegExp(`Independent agent review of ENG-75 @ ${head.slice(0, 12)} \\(fake-reviewer, read-only tools\\)`));
			assert.match(clean, /Overlapping open PR #9 \(linear\/ENG-99-other\): feature75\.txt/);
			assert.match(clean, /CHANGES NEEDED/);
			assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).verdict, "CHANGES NEEDED");
			assert.equal(JSON.parse(readFileSync(record, "utf8")).commit, head);

			const args = readFileSync(join(capture, "args"), "utf8");
			assert.match(args, /--extension .*extensions\/reviewer\.ts/);
			for (const flag of ["--no-extensions", "--no-skills", "--no-session", "--tools read,grep,find,ls", "--model openai-codex/gpt-5.5", "--thinking high"]) {
				assert.ok(args.includes(flag), `${flag} in ${args}`);
			}
			const packet = readFileSync(join(capture, "packet.md"), "utf8");
			assert.match(packet, /## Acceptance \(from the Linear issue\)\nFeature file exists\./);
			assert.match(packet, new RegExp(`HEAD \`${head}\``));
			assert.ok(packet.includes(`\`./scripts/verify --offline\`: pass (local) at ${head.slice(0, 12)}`));
			assert.match(packet, /\+v1/);
			assert.match(packet, /Never hand-edit generated output/);

			// A dirty tree is reviewed but the review does not count.
			writeFileSync(reviewer, script("READY FOR HUMAN REVIEW"));
			write(f.root, "feature75.txt", "v2 uncommitted\n");
			const dirty = (await s.run("/review")).messages.join("\n");
			assert.match(dirty, /plus uncommitted changes/);
			assert.match(dirty, /does not count for \/work finish/);
			assert.equal(JSON.parse(readFileSync(record, "utf8")).verdict, "CHANGES NEEDED", "the earlier clean review stands");
			assert.match(readFileSync(join(capture, "packet.md"), "utf8"), /\+v2 uncommitted/);
			git(f.root, "checkout", "-q", "--", "feature75.txt");

			// A reviewer that crashes or says nothing records nothing.
			writeFileSync(reviewer, script("READY FOR HUMAN REVIEW", 3));
			const failed = (await s.run("/review")).messages.join("\n");
			assert.match(failed, /Review failed \(exit 3\); no review is recorded/);
			assert.equal(JSON.parse(readFileSync(record, "utf8")).verdict, "CHANGES NEEDED");

			writeFileSync(reviewer, script("READY FOR HUMAN REVIEW"));
			await s.run("/review");
			assert.equal(JSON.parse(readFileSync(record, "utf8")).verdict, "READY FOR HUMAN REVIEW");
		} finally {
			delete process.env.PI_TEAM_REVIEWER_BIN;
			f.setPr(undefined);
			f.linear.get("ENG-75").state = "Done";
			git(f.root, "switch", "-q", "main");
		}
	});

	test("spec commands hand the method to the model in the right mode", async () => {
		write(f.root, "docs/changes/x.md", "---\nid: x\nlinear: ENG-30\n---\n# X\n## Requirements\n### R1 — A\nText\n");
		const s = f.session();
		const lint = (await s.run("/spec lint")).messages.join("\n");
		assert.match(lint, /FAIL {2}docs\/changes\/x\.md/);

		const plan = (await s.run("/spec plan docs/changes/x.md")).messages.join("\n");
		assert.match(plan, /Cannot plan until lint errors and blocking questions are resolved/);

		const draft = await s.run("/spec draft ENG-30");
		assert.match(draft.prompts[0], /specification\/SKILL\.md/);
		assert.match(draft.prompts[0], /Source: Linear issue ENG-30/);
		assert.equal(s.status["pi-team"], "foundations-idp · no issue · spec");

		const align = await s.run("/align docs/changes/x.md");
		assert.match(align.prompts[0], /This repo consumes foundations 0\.1\.0-alpha\.1 \(tag v0\.1\.0-alpha\.1, commit 3517dd4818a7\)/);
		assert.match(align.prompts[0], /FAIL {2}docs\/changes\/x\.md/);
		assert.equal(s.status["pi-team"], "foundations-idp · no issue · review");
		writeFileSync(join(f.root, "docs/changes/x.md"), "");
	});
});
