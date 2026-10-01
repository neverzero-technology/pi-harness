import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, loadProfiles, loadTeamConfig, matchesAny, normalizeOrigin, profileForOrigin } from "../src/config.ts";

test("origins normalise across URL forms", () => {
	const expected = "github.com/neverzero-technology/foundations";
	for (const url of [
		"https://github.com/neverzero-technology/foundations.git",
		"https://github.com/Neverzero-Technology/foundations",
		"git@github.com:neverzero-technology/foundations.git",
		"ssh://git@github.com/neverzero-technology/foundations",
		"https://user@github.com/neverzero-technology/foundations/",
	]) {
		assert.equal(normalizeOrigin(url), expected, url);
	}
});

test("profiles resolve by origin, not by directory", () => {
	const profiles = loadProfiles();
	assert.deepEqual(profiles.map((p) => p.name), ["foundations-idp", "foundations", "migratory"]);
	assert.equal(profileForOrigin(profiles, "git@github.com:neverzero-technology/foundations-idp.git")?.name, "foundations-idp");
	assert.equal(profileForOrigin(profiles, "https://github.com/neverzero-technology/foundations")?.name, "foundations");
	assert.equal(profileForOrigin(profiles, "https://github.com/someone/else"), undefined);
	assert.equal(profileForOrigin(profiles, undefined), undefined);
});

test("profiles are complete and the IDP pin names Foundations", () => {
	const profiles = loadProfiles();
	for (const p of profiles) {
		assert.ok(p.origins.length && p.linearLabel && p.defaultBranch && p.docs.length && p.verify.offline && p.invariants.length, p.name);
		assert.ok(Array.isArray(p.generated) && Array.isArray(p.legacy) && Array.isArray(p.verify.notes), p.name);
	}
	const idp = profiles.find((p) => p.name === "foundations-idp");
	assert.equal(idp?.pin?.file, "foundations-release/release.lock.yaml");
	assert.ok(profiles.some((p) => p.name === idp?.pin?.producer));
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
