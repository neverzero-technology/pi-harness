import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { specApproval } from "../src/approval.ts";
import { Git } from "../src/git.ts";
import { PendingStore, ReviewStore, reviewVerdict } from "../src/pending.ts";
import { readPin } from "../src/pin.ts";
import { specStaleness } from "../src/work.ts";
import { git, realExec, repoWithOrigin, tempDir, write } from "./helpers.ts";

test("working state reports branch, dirty files and unpushed commits", async () => {
	const { root } = repoWithOrigin();
	const g = new Git(realExec, root);
	let state = await g.state();
	assert.equal(state?.branch, "main");
	assert.equal(state?.unpushed, 0);
	write(root, "README.md", "changed\n");
	write(root, "new.txt", "x");
	git(root, "switch", "-qc", "linear/ENG-7-thing");
	state = await g.state();
	assert.deepEqual(state?.changed, ["README.md"]);
	assert.deepEqual(state?.untracked, ["new.txt"]);
	assert.equal(state?.upstream, undefined);
	assert.deepEqual(await g.branchesFor("eng-7"), ["linear/ENG-7-thing"]);
});

test("a new issue branch does not track the default branch, and is pushed only when its own remote branch exists", async () => {
	const { root } = repoWithOrigin();
	const g = new Git(realExec, root);
	assert.equal((await g.switchTo("linear/ENG-8-x", "origin/main", false)).code, 0);
	let state = await g.state();
	assert.equal(state?.upstream, undefined, "origin/main is not this branch's counterpart");
	assert.equal(git(root, "config", "--get", "--default", "none", "branch.linear/ENG-8-x.merge"), "none");

	write(root, "a.txt", "a");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "work");
	git(root, "push", "-q", "origin", "HEAD"); // no -u: no tracking configured
	state = await g.state();
	assert.equal(state?.upstream, "origin/linear/ENG-8-x");
	assert.equal(state?.unpushed, 0);
	write(root, "b.txt", "b");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "more");
	assert.equal((await g.state())?.unpushed, 1);

	// A worktree for a branch that exists on origin does track it.
	git(root, "switch", "-q", "main");
	git(root, "branch", "-qD", "linear/ENG-8-x");
	const dir = `${root}-wt`;
	assert.equal((await g.addWorktree(dir, "linear/ENG-8-x", "origin/linear/ENG-8-x", false)).code, 0);
	assert.equal((await g.at(dir).state())?.upstream, "origin/linear/ENG-8-x");
	assert.equal(await g.worktreeFor("linear/ENG-8-x"), git(dir, "rev-parse", "--show-toplevel"));
	assert.equal(await g.worktreeFor("linear/ENG-404"), undefined);
});

test("branches belong to the first issue key in their name, on this clone or origin only", async () => {
	const { root, origin } = repoWithOrigin();
	const g = new Git(realExec, root);
	for (const name of ["linear/ENG-12-thing", "linear/ENG-20-follow-up-to-eng-12", "dan/eng-120-other", "linear/ENG-1-first"]) git(root, "branch", name);
	git(root, "remote", "add", "upstream", origin);
	git(root, "push", "-q", "upstream", "linear/ENG-12-thing:linear/ENG-12-elsewhere");
	git(root, "fetch", "-q", "upstream");
	git(root, "push", "-q", "origin", "linear/ENG-12-thing");
	assert.deepEqual((await g.branchesFor("ENG-12")).sort(), ["linear/ENG-12-thing", "origin/linear/ENG-12-thing"]);
	assert.deepEqual(await g.branchesFor("ENG-1"), ["linear/ENG-1-first"]);
	assert.deepEqual(await g.branchesFor("ENG-120"), ["dan/eng-120-other"]);
	assert.deepEqual(await g.branchesFor("ENG-2"), []);
});

test("spec approval requires the spec merged to the default branch, unmodified", async () => {
	const { root } = repoWithOrigin();
	const g = new Git(realExec, root);
	const path = "docs/changes/x.md";
	write(root, path, "v1\n");
	assert.match((await specApproval(g, root, path, "origin/main")).detail, /uncommitted/);

	git(root, "switch", "-qc", "spec-branch");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "spec");
	const unmerged = await specApproval(g, root, path, "origin/main");
	assert.equal(unmerged.approved, false);
	assert.match(unmerged.detail, /not on origin\/main/);

	git(root, "push", "-q", "origin", "spec-branch:main");
	git(root, "fetch", "-q", "origin");
	const approved = await specApproval(g, root, path, "origin/main");
	assert.equal(approved.approved, true);
	assert.equal(approved.commit, git(root, "rev-parse", "HEAD"));

	// A spec later deleted on the default branch is not approved, even though a local copy remains.
	const local = git(root, "rev-parse", "HEAD");
	git(root, "rm", "-q", path);
	git(root, "commit", "-qm", "remove spec");
	git(root, "push", "-q", "origin", "spec-branch:main");
	git(root, "fetch", "-q", "origin");
	git(root, "reset", "-q", "--hard", local);
	const deleted = await specApproval(g, root, path, "origin/main");
	assert.equal(deleted.approved, false);
	assert.match(deleted.detail, /no longer exists on origin\/main/);
});

test("spec staleness detects changes after the planning revision", async () => {
	const { root } = repoWithOrigin();
	const g = new Git(realExec, root);
	write(root, "docs/changes/x.md", "v1\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "spec v1");
	const planned = git(root, "rev-parse", "HEAD");
	git(root, "push", "-q", "origin", "main");
	git(root, "fetch", "-q");
	const meta = { spec: "docs/changes/x.md", specRepo: "acme-app", specCommit: planned, requirements: [] };
	assert.equal((await specStaleness(g, meta, "acme-app", "origin/main")).status, "current");
	assert.equal((await specStaleness(g, { ...meta, specRepo: "other-app" }, "acme-app", "origin/main")).status, "unverifiable");
	assert.equal((await specStaleness(g, { requirements: [] }, "acme-app", "origin/main")).status, "none");

	write(root, "docs/changes/x.md", "v2\n");
	git(root, "commit", "-qam", "spec v2");
	git(root, "push", "-q", "origin", "main");
	git(root, "fetch", "-q");
	const changed = await specStaleness(g, meta, "acme-app", "origin/main");
	assert.equal(changed.status, "changed");
	assert.match(changed.detail, /spec v2/);
});

test("pending checkpoints persist per issue in the shared git dir", () => {
	const store = new PendingStore(tempDir());
	assert.deepEqual(store.list(), []);
	const pending = { id: "cp-1", issue: "ENG-1", body: "b", createdAt: "t", error: "", uncertain: true };
	store.put(pending);
	store.put({ ...pending, id: "cp-2" });
	assert.equal(store.get("ENG-1")?.id, "cp-2");
	assert.equal(store.list().length, 1);
	store.clear("ENG-1");
	assert.equal(store.get("ENG-1"), undefined);
});

test("release pin is read from the release block", () => {
	const root = tempDir();
	write(
		root,
		"release.lock.yaml",
		"schema: 1\nrelease:\n  repository: example/platform\n  version: 0.1.0-alpha.1\n  tag: v0.1.0-alpha.1\n  commit: 3517dd4818a7c578b65064ea55b634778bfa041d\nassets:\n  - name: x\n    version: 9.9.9\n",
	);
	const pin = readPin(root, { file: "release.lock.yaml", producer: "platform", versionField: "version", commitField: "commit" });
	assert.deepEqual(pin, {
		file: "release.lock.yaml",
		producer: "platform",
		version: "0.1.0-alpha.1",
		commit: "3517dd4818a7c578b65064ea55b634778bfa041d",
		tag: "v0.1.0-alpha.1",
	});
	assert.equal(readPin(tempDir(), { file: "missing.yaml", producer: "f", versionField: "version", commitField: "commit" }), undefined);
});

test("agent reviews are recorded per issue with their verdict", () => {
	const store = new ReviewStore(tempDir());
	assert.equal(store.get("ENG-1"), undefined);
	store.put({ issue: "ENG-1", commit: "abc", verdict: reviewVerdict("Verdict: CHANGES NEEDED\n- finding"), at: "t" });
	assert.equal(store.get("ENG-1")?.verdict, "CHANGES NEEDED");
	assert.equal(reviewVerdict("READY FOR HUMAN REVIEW"), "READY FOR HUMAN REVIEW");
	assert.equal(reviewVerdict("looks fine"), "UNKNOWN");
});

test("host-side git never runs the repository's hooks or fsmonitor command", async () => {
	const { root, origin } = repoWithOrigin();
	const g = new Git(realExec, root);
	const marker = join(root, "hook-ran");
	const hook = (name: string, body: string) => {
		write(root, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
		chmodSync(join(root, ".git/hooks", name), 0o755);
	};
	hook("post-checkout", `touch "${marker}"`);
	hook("pre-push", `touch "${marker}"; exit 1`);
	write(root, "fsmonitor.sh", `#!/bin/sh\ntouch "${marker}"\n`);
	chmodSync(join(root, "fsmonitor.sh"), 0o755);
	git(root, "config", "core.fsmonitor", join(root, "fsmonitor.sh"));

	assert.equal((await g.switchTo("linear/ENG-9-x", "origin/main", false)).code, 0);
	await g.state();
	git(root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "commit", "-qm", "work", "--allow-empty");
	assert.equal((await g.push("linear/ENG-9-x")).code, 0, "a failing pre-push hook does not stop the harness, because it is not run");
	assert.equal((await g.addWorktree(`${root}-wt`, "linear/ENG-9-y", "origin/main", false)).code, 0);
	assert.equal(existsSync(marker), false);
	assert.equal(git(origin, "rev-parse", "linear/ENG-9-x"), git(root, "-c", "core.fsmonitor=false", "rev-parse", "HEAD"));
});
