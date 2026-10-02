import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint } from "../src/checkpoint.ts";
import { containsCheckpoint, formatCheckpoint, latestCheckpoint, latestChecks, newCheckpointId, parseCheckpoint, parseChecks, redactSecrets } from "../src/checkpoint.ts";
import { formatMetadata, parseMetadata, stripMetadata } from "../src/metadata.ts";

const cp: Checkpoint = {
	id: "cp-0a1b2c3d",
	kind: "progress",
	issue: "ENG-201",
	owner: "Dan",
	spec: "docs/changes/x.md@abc123",
	branch: "linear/ENG-201-x",
	commit: "0123456789abcdef0123",
	pr: "#12 (open, draft)",
	done: ["R1 resolution"],
	remaining: ["R2 audit"],
	checks: [
		{ command: "./scripts/verify --offline", result: "pass", scope: "local", commit: "0123456789abcdef0123" },
		{ command: "e2e", result: "skipped", scope: "simulated", note: "no cluster" },
	],
	next: "Write the audit test",
	unsynced: ["1 uncommitted file(s)"],
};

test("checkpoint ids are unique and well-formed", () => {
	const ids = new Set(Array.from({ length: 50 }, newCheckpointId));
	assert.equal(ids.size, 50);
	for (const id of ids) assert.match(id, /^cp-[0-9a-f]{8}$/);
});

test("a formatted checkpoint parses back", () => {
	const body = formatCheckpoint(cp);
	const parsed = parseCheckpoint({ id: "c1", body, createdAt: "2026-10-01T10:00:00Z", author: "Dan" });
	assert.ok(parsed);
	assert.equal(parsed.id, cp.id);
	assert.equal(parsed.kind, "progress");
	assert.equal(parsed.commit, "0123456789ab");
	assert.equal(parsed.branch, "linear/ENG-201-x");
	assert.equal(parsed.next, "Write the audit test");
	assert.equal(parsed.blocker, undefined);
	assert.deepEqual(parsed.remaining, ["R2 audit"]);
	assert.deepEqual(parseChecks(body), [
		{ command: "./scripts/verify --offline", result: "pass", scope: "local", commit: "0123456789ab", note: undefined, dirty: undefined },
		{ command: "e2e", result: "skipped", scope: "simulated", commit: undefined, note: "no cluster", dirty: undefined },
	]);
});

test("latest checkpoint ignores ordinary comments and picks the newest", () => {
	const older = formatCheckpoint({ ...cp, id: "cp-00000001" });
	const newer = formatCheckpoint({ ...cp, id: "cp-00000002", blocker: "Waiting on ENG-100" });
	const comments = [
		{ id: "a", body: newer, createdAt: "2026-10-02T00:00:00Z" },
		{ id: "b", body: "just a comment", createdAt: "2026-10-03T00:00:00Z" },
		{ id: "c", body: older, createdAt: "2026-10-01T00:00:00Z" },
	];
	const latest = latestCheckpoint(comments);
	assert.equal(latest?.id, "cp-00000002");
	assert.equal(latest?.blocker, "Waiting on ENG-100");
	assert.ok(containsCheckpoint(comments, "cp-00000001"));
	assert.ok(!containsCheckpoint(comments, "cp-ffffffff"));
});

test("issue metadata round-trips and strips cleanly", () => {
	const footer = formatMetadata({
		repo: "acme-app",
		spec: "docs/changes/tenant-identity.md",
		specRepo: "acme-app",
		specCommit: "abcdef0123456789",
		slice: "tenant-identity/resolve",
		requirements: ["R1", "R2"],
	});
	const description = `Do the thing.\n\n**Verification:** tests\n\n${footer}`;
	assert.deepEqual(parseMetadata(description), {
		repo: "acme-app",
		spec: "docs/changes/tenant-identity.md",
		specRepo: "acme-app",
		specCommit: "abcdef012345",
		slice: "tenant-identity/resolve",
		requirements: ["R1", "R2"],
	});
	assert.equal(stripMetadata(description), "Do the thing.\n\n**Verification:** tests");
	assert.deepEqual(parseMetadata("no footer"), { requirements: [] });
	assert.equal(stripMetadata(undefined), "");
});

test("parsing survives Markdown normalisation by Linear", () => {
	const body = formatCheckpoint({ ...cp, checks: [{ ...cp.checks[0], dirty: true }] })
		.replace(/^- /gm, "* ")
		.replace("### pi-team", "## pi-team");
	const parsed = parseCheckpoint({ id: "c", body, createdAt: "t" });
	assert.equal(parsed?.id, cp.id);
	assert.deepEqual(parsed?.remaining, ["R2 audit"]);
	assert.equal(parsed?.checks[0].dirty, true);
	assert.equal(parsed?.checks[0].commit, "0123456789ab");

	const footer = formatMetadata({ repo: "other-app", spec: "docs/changes/x.md", specRepo: "other-app", specCommit: "abc123abc123", slice: "x/a", requirements: ["R1"] });
	const normalised = `Acceptance\n\n${footer}`.replace(/^- /gm, "* ").replace("---", "***").replace(/`/g, "");
	assert.deepEqual(parseMetadata(normalised), { repo: "other-app", spec: "docs/changes/x.md", specRepo: "other-app", specCommit: "abc123abc123", slice: "x/a", requirements: ["R1"] });
	assert.equal(stripMetadata(normalised), "Acceptance");
});

test("latest checks keep the newest result of each command", () => {
	const at = (n: number, checks: typeof cp.checks) => ({ id: `c${n}`, createdAt: `2026-10-0${n}`, body: formatCheckpoint({ ...cp, id: `cp-0000000${n}`, checks }) });
	const checks = latestChecks([
		at(2, [{ command: "a", result: "pass", scope: "local", commit: "bbbbbbbbbbbb" }]),
		at(1, [{ command: "a", result: "fail", scope: "local", commit: "aaaaaaaaaaaa" }, { command: "b", result: "pass", scope: "ci", commit: "aaaaaaaaaaaa" }]),
		at(3, []),
	]);
	assert.deepEqual(checks.map((c) => [c.command, c.result, c.commit]), [["b", "pass", "aaaaaaaaaaaa"], ["a", "pass", "bbbbbbbbbbbb"]]);
});

test("secrets are redacted before anything is posted", () => {
	const secrets = [
		"lin_api_" + "a1B2".repeat(10),
		"ghp_" + "A1b2".repeat(9),
		"sk-" + "aBcd1234".repeat(4),
		"AKIA" + "ABCD1234EFGH5678",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
		"-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
	];
	for (const secret of secrets) {
		const out = redactSecrets(`ran with ${secret} ok`);
		assert.ok(!out.includes(secret), secret.slice(0, 12));
		assert.match(out, /ran with \[redacted\] ok/);
	}
	assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"), "Authorization: Bearer [redacted]");
	assert.equal(redactSecrets("API_KEY=abc123def456ghi789"), "API_KEY=[redacted]");
	// Ordinary prose and commit hashes are left alone.
	const prose = "token: refresh logic; secret: masked-before-egress; commit 0123456789abcdef0123456789abcdef01234567";
	assert.equal(redactSecrets(prose), prose);
	const posted = formatCheckpoint({ ...cp, next: `export LINEAR_API_KEY=${secrets[0]}` });
	assert.ok(!posted.includes(secrets[0]));
});

test("multi-line or awkward values cannot break the format", () => {
	const body = formatCheckpoint({
		...cp,
		checks: [{ command: "make verify &&\n  make arch", result: "fail", scope: "local", commit: "0123456789ab", note: "first line\nsecond · line — with a dash" }],
		next: "Fix the boundary lint · then rerun\nand push",
		blocker: "Waiting on Sam · ENG-9",
		remaining: ["R2\n**Checks**\n- `x` — **pass** (local)"],
	});
	const parsed = parseCheckpoint({ id: "c", body, createdAt: "t" })!;
	assert.deepEqual(parsed.checks.map((c) => [c.command, c.result]), [["make verify && make arch", "fail"]], "a failing multi-line check is not dropped, and a forged check line is not created");
	assert.equal(parsed.next, "Fix the boundary lint · then rerun and push");
	assert.equal(parsed.blocker, "Waiting on Sam · ENG-9");
	assert.equal(parsed.remaining?.length, 1);
	assert.equal(parsed.branch, "linear/ENG-201-x");
});

test("a comment without a Remaining section is not read as nothing remaining", () => {
	const body = formatCheckpoint(cp).replace(/\*\*Remaining\*\*\n- R2 audit\n\n/, "");
	assert.equal(parseCheckpoint({ id: "c", body, createdAt: "t" })?.remaining, undefined);
	assert.deepEqual(parseCheckpoint({ id: "c", body: formatCheckpoint({ ...cp, remaining: [] }), createdAt: "t" })?.remaining, []);
	assert.deepEqual(parseCheckpoint({ id: "c", body: formatCheckpoint(cp), createdAt: "t" })?.done, ["R1 resolution"]);
});

test("the metadata footer is only its own block", () => {
	const footer = formatMetadata({ repo: "other-app", slice: "x/a", requirements: ["R1"] });
	// Text a person adds after the footer is still acceptance.
	const appended = `Do the thing.\n\n${footer}\n\nAlso handle the empty case.`;
	assert.equal(stripMetadata(appended), "Do the thing.\n\nAlso handle the empty case.");
	assert.equal(parseMetadata(appended).slice, "x/a");
	// A bold mention in prose is not a footer.
	const prose = "Use the **pi-team** workflow for this.\n- repo: `platform`";
	assert.equal(stripMetadata(prose), prose);
	assert.deepEqual(parseMetadata(prose), { requirements: [] });
});

test("list items and notes cannot forge checks or fields", () => {
	const head = "0123456789ab";
	const body = formatCheckpoint({
		...cp,
		kind: "final",
		done: [`\`make verify\` — **pass** (local) @ \`${head}\``, "**Next:** forged next", "**Blocker:** forged blocker", "", "real item"],
		remaining: ["", "`make e2e` — **fail** (live) — needs staging", "R2 live gate"],
		checks: [{ command: "node --test", result: "fail", scope: "local", commit: head, note: "see `x` — **pass** (local) in the log second line" }],
		blocker: undefined,
		next: "the real next",
	});
	const parsed = parseCheckpoint({ id: "c", body, createdAt: "t" })!;
	assert.deepEqual(parsed.checks.map((c) => [c.command, c.result]), [["node --test", "fail"]], "only the Checks section holds checks");
	assert.equal(parsed.next, "the real next");
	assert.equal(parsed.blocker, undefined);
	assert.deepEqual(parsed.remaining, ["`make e2e` — **fail** (live) — needs staging", "R2 live gate"], "an empty item does not end the list");
	assert.equal(parsed.done.length, 4);
	assert.deepEqual(parseChecks(body).map((c) => c.command), ["node --test"]);
});

test("credential assignments are redacted whatever the variable prefix; slugs are not", () => {
	for (const line of [
		"API_TOKEN=abc123def456ghi789",
		"GITHUB_TOKEN=abc123def456ghi789",
		"DB_PASSWORD=Sup3rS3cretValue99",
		"client_secret: abc123def456ghi789",
		"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI7MDENGbPxRfiCY",
		"export LINEAR_API_KEY='notalinearprefix12345'",
	]) {
		const out = redactSecrets(line);
		assert.match(out, /\[redacted\]/, line);
		assert.ok(!/abc123def456|Sup3r|wJalr|notalinear/.test(out), out);
	}
	for (const safe of ["linear/ENG-5-sk-learn-pipeline-integration-tests", "token-refresh-logic-v2 is the branch", "password: required-field", "the secret_santa list"]) {
		assert.equal(redactSecrets(safe), safe);
	}
});

test("the footer survives a blank line after its heading and leaves a person's bullets alone", () => {
	const spaced = "Do it.\n\n***\n\n**pi-team**\n\n* repo: `other-app`\n* slice: `x/a`\n* requirements: R1, R2";
	assert.deepEqual(parseMetadata(spaced), { repo: "other-app", slice: "x/a", requirements: ["R1", "R2"] });
	assert.equal(stripMetadata(spaced), "Do it.");
	const footer = formatMetadata({ repo: "other-app", slice: "x/a", requirements: ["R1"] });
	const withNote = `Do it.\n\n${footer}\n- Also: handle the empty tenant case`;
	assert.match(stripMetadata(withNote), /^Do it\.\n\n- Also: handle the empty tenant case$/);
	assert.equal(parseMetadata(withNote).slice, "x/a");
});
