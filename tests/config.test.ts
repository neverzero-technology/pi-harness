import assert from "node:assert/strict";
import { test } from "node:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, loadTeamConfig, matchesAny, packageStamp, repoNameFromOrigin } from "../src/config.ts";
import { Team } from "../src/runtime.ts";
import { Git } from "../src/git.ts";
import { loadProfile, parseProfile, PROFILE_PATH } from "../src/profile.ts";
import { git, PROFILE, profiledRepo, realExec, tempDir, write } from "./helpers.ts";

test("the repository name comes from any form of origin URL", () => {
	for (const url of ["https://github.com/acme/acme-app.git", "git@github.com:acme/acme-app.git", "ssh://git@github.com/acme/acme-app", "/srv/git/acme-app.git/", "acme-app"]) {
		assert.equal(repoNameFromOrigin(url), "acme-app", url);
	}
	assert.equal(repoNameFromOrigin(undefined), undefined);
	assert.equal(repoNameFromOrigin("git@github.com:acme/has space.git"), undefined);
});

test("team config maps every logical state", () => {
	const config = loadTeamConfig();
	assert.deepEqual(Object.keys(config.linear.states).sort(), ["backlog", "canceled", "done", "inProgress", "inReview", "ready"]);
	assert.match(config.model.id, /^[\w-]+\/[\w.-]+$/);
});

test("globs", () => {
	assert.ok(globToRegExp("a/**").test("a/b/c.txt"));
	assert.ok(globToRegExp("a/**/c.txt").test("a/c.txt"));
	assert.ok(globToRegExp("a/*.yaml").test("a/x.yaml"));
	assert.ok(!globToRegExp("a/*.yaml").test("a/b/x.yaml"));
	assert.ok(!globToRegExp("a.b").test("axb"));
	assert.equal(matchesAny("platform/rgds/x.yaml", ["vendor/**", "platform/rgds/**"]), "platform/rgds/**");
});

test("a profile is validated and given its defaults", () => {
	const { profile, errors } = parseProfile(JSON.stringify({ name: "acme-app", verify: { offline: "make check" } }));
	assert.deepEqual(errors, []);
	assert.deepEqual(profile, {
		name: "acme-app",
		defaultBranch: undefined,
		docs: [],
		verify: { offline: "make check", full: undefined, selected: undefined, notes: [] },
		generated: [],
		invariants: [],
		pins: [],
		consumers: [],
		linear: { label: "repo:acme-app", project: undefined },
	});
	const full = parseProfile(JSON.stringify({ ...PROFILE, linear: { label: "area:acme", project: "Acme" } })).profile;
	assert.deepEqual(full?.pins, [{ file: "release.lock.yaml", producer: "platform", versionField: "version", commitField: "commit" }]);
	assert.deepEqual(full?.linear, { label: "area:acme", project: "Acme" });
	// Empty optional strings mean "not set yet", as the agent leaves them before /discover linear.
	const blank = parseProfile(JSON.stringify({ ...PROFILE, linear: { label: "", project: "" } }));
	assert.deepEqual(blank.errors, []);
	assert.deepEqual(blank.profile?.linear, { label: "repo:acme-app", project: undefined });
	assert.match(parseProfile(JSON.stringify({ ...PROFILE, linear: { project: 3 } })).errors[0], /"linear.project" must be a non-empty string/);
});

test("an invalid profile says exactly what is wrong", () => {
	assert.match(parseProfile("{ not json").errors[0], /not valid JSON/);
	assert.match(parseProfile("[]").errors[0], /must be a JSON object/);
	const errors = parseProfile(JSON.stringify({ name: "has space", docs: "AGENTS.md", verify: { full: 3 }, pins: [{ file: "x" }], generated: [1] })).errors.join("\n");
	assert.match(errors, /"name" is required/);
	assert.match(errors, /"verify.offline" is required/);
	assert.match(errors, /"verify.full" must be a command string/);
	assert.match(errors, /"docs" must be a list of strings/);
	assert.match(errors, /"generated" must be a list of strings/);
	assert.match(errors, /"pins\[0\]" needs "file" and "producer"/);
});

test("the default branch's profile is the one in force; the working tree only counts before adoption", async () => {
	// Not yet adopted: nothing anywhere.
	const fresh = profiledRepo(null);
	const freshGit = new Git(realExec, fresh.root);
	assert.deepEqual(await loadProfile(freshGit, fresh.root, "origin/main"), { profile: undefined, source: "none", errors: [], unmerged: false });

	// Being adopted: written on a branch, not merged.
	write(fresh.root, PROFILE_PATH, JSON.stringify(PROFILE));
	const adopting = await loadProfile(freshGit, fresh.root, "origin/main");
	assert.equal(adopting.source, "working-tree");
	assert.equal(adopting.profile?.name, "acme-app");
	assert.equal(adopting.unmerged, true);

	// Adopted: the merged copy rules, and a local edit is reported but not applied.
	const adopted = profiledRepo();
	const adoptedGit = new Git(realExec, adopted.root);
	assert.equal((await loadProfile(adoptedGit, adopted.root, "origin/main")).source, "default-branch");
	write(adopted.root, PROFILE_PATH, JSON.stringify({ ...PROFILE, generated: [], invariants: [] }));
	const edited = await loadProfile(adoptedGit, adopted.root, "origin/main");
	assert.equal(edited.source, "default-branch");
	assert.equal(edited.unmerged, true);
	assert.equal(edited.profile?.generated.length, 2, "weakening the profile locally changes nothing until it is merged");

	// An invalid merged profile is an error, not a silent fallback to the working tree.
	write(adopted.root, PROFILE_PATH, "{ broken");
	git(adopted.root, "commit", "-qam", "break profile");
	git(adopted.root, "push", "-q", "origin", "main");
	const broken = await loadProfile(adoptedGit, adopted.root, "origin/main");
	assert.equal(broken.profile, undefined);
	assert.match(broken.errors[0], /not valid JSON/);
});

test("the default branch is detected from origin", async () => {
	const { root, origin } = profiledRepo();
	const g = new Git(realExec, root);
	assert.equal(await g.defaultBranch(), "main");
	git(root, "push", "-q", "origin", "main:trunk");
	git(origin, "symbolic-ref", "HEAD", "refs/heads/trunk");
	git(root, "remote", "set-head", "origin", "--auto");
	assert.equal(await g.defaultBranch(), "trunk");
});

test("a session can tell when the harness on disk is newer than the code it loaded", () => {
	// The stamp is the newest file time under the code and prompt directories.
	const root = tempDir();
	write(root, "src/a.ts", "a");
	write(root, "skills/x/SKILL.md", "s");
	write(root, "README.md", "not code");
	const before = packageStamp(root);
	utimesSync(join(root, "README.md"), new Date(), new Date(Date.now() + 60_000));
	assert.equal(packageStamp(root), before, "files outside the code and prompt directories do not count");
	utimesSync(join(root, "skills/x/SKILL.md"), new Date(), new Date(Date.now() + 60_000));
	assert.ok(packageStamp(root) > before);
	assert.equal(packageStamp(join(root, "missing")), 0);

	// The session reports each update once, and not more often than every few seconds.
	let onDisk = 100;
	const team = new Team({} as never, () => onDisk);
	assert.equal(team.staleNotice(10_000), undefined);
	assert.equal(team.isStale(), false);
	onDisk = 200;
	assert.equal(team.staleNotice(11_000), undefined, "checked at most every three seconds");
	assert.match(team.staleNotice(14_000) ?? "", /updated on disk after this session loaded it.*Run \/reload/);
	assert.equal(team.staleNotice(20_000), undefined, "said once per update");
	assert.equal(team.isStale(), true);
	onDisk = 300;
	assert.match(team.staleNotice(30_000) ?? "", /Run \/reload/);
});
