import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseProfile } from "../src/profile.ts";
import { PROFILE } from "./helpers.ts";
import { reviewVerdict } from "../src/pending.ts";
import { buildReviewPacket, piInvocation, REVIEW_TOOLS, runReviewer } from "../src/review.ts";
import { tempDir, write } from "./helpers.ts";

test("reviewer tools are read-only", () => {
	assert.deepEqual(REVIEW_TOOLS, ["read", "grep", "find", "ls"]);
});

test("review packet carries acceptance, constraints, tested source and evidence", () => {
	const profile = parseProfile(JSON.stringify(PROFILE)).profile;
	const packet = buildReviewPacket({
		issue: "ENG-201",
		title: "Tenant resolution",
		url: "https://linear.app/x/ENG-201",
		acceptance: "Reject conflicting tenant input.",
		spec: "docs/changes/tenant-identity.md",
		profile,
		head: "abc123",
		base: "def456",
		dirtyFiles: ["src/a.ts"],
		checkpoint: undefined,
		checks: [
			{ command: "make verify", result: "pass", scope: "local", commit: "abc123" },
			{ command: "e2e", result: "pass", scope: "ci", commit: "0ld999", dirty: true },
		],
		diff: "+ code",
		diffTruncated: true,
		diffStat: " src/a.ts | 1 +",
	});
	assert.match(packet, /Reject conflicting tenant input/);
	assert.match(packet, /docs\/changes\/tenant-identity\.md/);
	assert.match(packet, /Tenancy comes from the tenant record/);
	assert.match(packet, /templates\/generated\/\*\*/);
	assert.match(packet, /HEAD `abc123`/);
	assert.match(packet, /Uncommitted changes are present/);
	assert.match(packet, /No checkpoint recorded/);
	assert.match(packet, /- `make verify`: pass \(local\) at abc123\n/);
	assert.match(packet, /- `e2e`: pass \(ci\) at 0ld999, on a tree with uncommitted changes — not this HEAD/);
	assert.match(packet, /truncated/);
	assert.doesNotMatch(packet, /\n\n\n/);
});

test("reviewer runs the same Pi binary, or an explicit override", () => {
	process.env.PI_TEAM_PI_BIN = "/opt/pi";
	assert.deepEqual(piInvocation(["-p"]), { command: "/opt/pi", args: ["-p"] });
	delete process.env.PI_TEAM_PI_BIN;
});

test("review cannot start if its read-only sandbox extension fails to load", async () => {
	const cwd = tempDir();
	const bin = join(cwd, "reviewer");
	const started = join(cwd, "started");
	write(cwd, "reviewer", `#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\ntouch "${started}"\n`);
	chmodSync(bin, 0o755);
	const previous = process.env.PI_TEAM_REVIEWER_BIN;
	process.env.PI_TEAM_REVIEWER_BIN = bin;
	try {
		const result = await runReviewer({ cwd, packet: "packet", systemPrompt: "review", model: "unused", thinking: "high" });
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /sandbox failed to load.*execution is blocked/);
		assert.equal(existsSync(started), false);
	} finally {
		if (previous === undefined) delete process.env.PI_TEAM_REVIEWER_BIN;
		else process.env.PI_TEAM_REVIEWER_BIN = previous;
	}
});

test("the verdict is a line that states it, never a phrase inside prose", () => {
	assert.equal(reviewVerdict("READY FOR HUMAN REVIEW\n\nNo findings."), "READY FOR HUMAN REVIEW");
	assert.equal(reviewVerdict("**Verdict:** `CHANGES NEEDED`\n1. ..."), "CHANGES NEEDED");
	assert.equal(reviewVerdict("## CANNOT ASSESS: the diff is empty"), "CANNOT ASSESS");
	assert.equal(reviewVerdict("NOT READY FOR HUMAN REVIEW: tests missing"), "UNKNOWN");
	assert.equal(reviewVerdict("This is not yet READY FOR HUMAN REVIEW.\n\nVerdict: CHANGES NEEDED"), "CHANGES NEEDED");
	assert.equal(reviewVerdict("Looks fine to me."), "UNKNOWN");
	assert.equal(reviewVerdict(""), "UNKNOWN");
});
