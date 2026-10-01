import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { lintSpec, lintSpecFile } from "../src/spec.ts";
import { LINT, tempDir, VALID_SPEC, write } from "./helpers.ts";

function setup(spec = VALID_SPEC) {
	const root = tempDir();
	write(root, "PLAN.md", "# plan\n");
	write(root, "docs/changes/tenant-identity.md", spec);
	const path = join(root, "docs/changes/tenant-identity.md");
	return { root, run: (text = spec) => lintSpec(text, path, { repoRoot: root, ...LINT }) };
}

test("host-side spec lint cannot read files or capability baselines outside the repository", () => {
	const { root } = setup();
	const outside = tempDir();
	write(outside, "secret.md", VALID_SPEC);
	symlinkSync(join(outside, "secret.md"), join(root, "docs/changes/escape.md"));
	const options = { repoRoot: root, ...LINT };
	assert.throws(() => lintSpecFile(join(outside, "secret.md"), options), /inside the repository/);
	assert.throws(() => lintSpecFile(join(root, "docs/changes/escape.md"), options), /symlink escapes/);
	write(root, `${LINT.capabilitiesDir}/placeholder.md`, "");
	symlinkSync(join(outside, "secret.md"), join(root, LINT.capabilitiesDir, "tenant-onboarding.md"));
	const modified = VALID_SPEC.replace("### R1 —", "### Modified: R1 —");
	const result = lintSpec(modified, join(root, "docs/changes/x.md"), options);
	assert.match(result.errors.map((e) => e.message).join("\n"), /Capability baseline is outside the repository/);
});

test("frontmatter parses scalars, inline and block lists", () => {
	const doc = parseFrontmatter("---\nid: a\ntags: [x, 'y']\ncaps:\n  - one\n  - two\n---\n# Body\n");
	assert.deepEqual(doc.frontmatter, { id: "a", tags: ["x", "y"], caps: ["one", "two"] });
	assert.equal(doc.body.trim(), "# Body");
	assert.equal(doc.bodyStartLine, 8);
});

test("frontmatter reports a missing terminator", () => {
	assert.match(parseFrontmatter("---\nid: a\n").errors[0], /closing/);
});

test("a well-formed spec passes with its requirements counted", () => {
	const { run } = setup();
	const result = run();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.spec.requirements.map((r) => [r.id, r.scenarios]), [["R1", 2], ["R2", 1]]);
	assert.equal(result.spec.linear, "ENG-142");
	assert.deepEqual(result.spec.capabilities, ["tenant-onboarding"]);
	assert.deepEqual(result.warnings, []);
});

test("missing sections, scenarios and frontmatter are errors", () => {
	const { run } = setup();
	const result = run("# Title\n\n## Requirements\n\n### R1 — Thing\nBehaviour.\n");
	const messages = result.errors.map((e) => e.message).join("\n");
	assert.match(messages, /Missing YAML frontmatter/);
	assert.match(messages, /Missing section "## Outcome"/);
	assert.match(messages, /Missing section "## Verification"/);
	assert.match(messages, /R1 has no "#### Scenario"/);
});

test("duplicate IDs and unidentified requirement headings are errors", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace("### R2 — Audit", "### R1 — Audit").replace("## Relevant contracts", "### Unnumbered\n\n## Relevant contracts");
	const messages = run(spec).errors.map((e) => e.message).join("\n");
	assert.match(messages, /Duplicate requirement ID R1/);
	assert.doesNotMatch(messages, /Unnumbered/); // the heading sits outside Requirements
	const inside = VALID_SPEC.replace("### R2 — Audit", "### Audit without id");
	assert.match(run(inside).errors.map((e) => e.message).join("\n"), /Requirement heading needs an ID/);
});

test("broken relative links are errors; URLs and anchors are not checked", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace("See [the plan](../../PLAN.md).", "See [gone](../../MISSING.md), [web](https://x.dev) and [here](#outcome).");
	const errors = run(spec).errors;
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /Broken link: \.\.\/\.\.\/MISSING\.md/);
});

test("BLOCKING questions are surfaced and placeholders warned", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace("- Decision (human)", "- BLOCKING: who owns retention?\n- Decision (human)").replace(
		"R2 audit test.",
		"R2 <check> and `List<T>` in code is fine.",
	);
	const result = run(spec);
	assert.equal(result.spec.blocking.length, 1);
	assert.match(result.spec.blocking[0].message, /who owns retention/);
	assert.equal(result.warnings.filter((w) => /placeholder/.test(w.message)).length, 1);
});

test("size thresholds warn but do not fail", () => {
	const { root } = setup();
	const many = Array.from({ length: 16 }, (_, i) => `### R${i + 1} — Req\nText.\n\n#### Scenario: s\nGiven a, when b, then c.\n`).join("\n");
	const spec = VALID_SPEC.replace(/## Requirements[\s\S]*## Relevant contracts/, `## Requirements\n\n${many}\n## Relevant contracts`);
	const result = lintSpec(spec, join(root, "docs/changes/tenant-identity.md"), { repoRoot: root, ...LINT, warnWords: 100 });
	assert.deepEqual(result.errors, []);
	assert.ok(result.warnings.some((w) => /16 requirements/.test(w.message)));
	assert.ok(result.warnings.some((w) => /words/.test(w.message)));
});

test("Modified requirements are checked against an opt-in capability baseline", () => {
	const { root, run } = setup();
	const spec = VALID_SPEC.replace("### R1 — Tenant resolution", "### Modified: TEN-01 — Tenant resolution");
	assert.ok(run(spec).warnings.some((w) => /no capability baseline/.test(w.message)));

	write(root, "docs/specs/tenant-onboarding.md", "## Requirements\n\n### TEN-02 — Other\n");
	assert.ok(run(spec).errors.some((e) => /Modified TEN-01 is not in the capability baseline/.test(e.message)));

	write(root, "docs/specs/tenant-onboarding.md", "## Requirements\n\n### TEN-01 — Tenant resolution\n");
	assert.deepEqual(run(spec).errors, []);
});

test("fenced code is ignored", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace("## Verification", "```\n## Not a section\n### R9 — not a requirement\n```\n\n## Verification");
	const result = run(spec);
	assert.deepEqual(result.errors, []);
	assert.equal(result.spec.requirements.length, 2);
});

test("only an item that starts with BLOCKING blocks planning", () => {
	const { run } = setup();
	const decisions = [
		"- BLOCKING: who owns retention?",
		"- **BLOCKING**: second real one",
		"- No BLOCKING questions remain about audit.",
		"- NON-BLOCKING: naming of the event",
		"- ~~BLOCKING: resolved earlier~~",
	].join("\n");
	const result = run(VALID_SPEC.replace("- Decision (human)", `${decisions}\n- Decision (human)`));
	assert.deepEqual(result.spec.blocking.map((b) => b.message), ["BLOCKING: who owns retention?", "**BLOCKING**: second real one"]);
});

test("tilde fences, closing hashes and CRLF are handled", () => {
	const { run } = setup();
	const tilde = VALID_SPEC.replace("## Verification", "~~~md\n## Requirements\n### R9 — sample\n```\n~~~\n\n## Verification ##");
	const result = run(tilde.replace(/\n/g, "\r\n"));
	assert.deepEqual(result.errors, []);
	assert.equal(result.spec.requirements.length, 2);
	assert.equal(result.spec.title, "Tenant identity resolution");
});

test("links: titles, angle brackets and code are understood", () => {
	const { root, run } = setup();
	write(root, "docs/a b.md", "x");
	const links = [
		'[titled](../../PLAN.md "The plan")',
		"[spaced](<../a b.md>)",
		"[encoded](../a%20b.md)",
		"call `[x](missing.md)` in code and handlers[0](event) in prose",
		'[gone](../../MISSING.md "t")',
	].join(" ");
	const errors = run(VALID_SPEC.replace("See [the plan](../../PLAN.md).", links)).errors;
	assert.deepEqual(errors.map((e) => e.message), ["Broken link: ../../MISSING.md"]);
});

test("frontmatter accepts unindented list items", () => {
	const doc = parseFrontmatter("---\nid: a\ncapabilities:\n- one\n- two\n---\nbody");
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.frontmatter?.capabilities, ["one", "two"]);
});

test("BLOCKING is recognised in every common list form", () => {
	const { run } = setup();
	const forms = ["- [ ] BLOCKING: task box", "1. BLOCKING: numbered", "- *BLOCKING*: emphasised", "> BLOCKING: quoted", "BLOCKING: bare"];
	const result = run(VALID_SPEC.replace("- Decision (human)", `${forms.join("\n")}\n- Decision (human)`));
	assert.equal(result.spec.blocking.length, forms.length);
});

test("an unclosed fence is an error, not a way to hide the rest of the spec", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace("- Decision (human)", "```yaml\nkey: value\n\n- BLOCKING: hidden question\n- Decision (human)");
	assert.ok(run(spec).errors.some((e) => /Code fence opened here is never closed/.test(e.message)));
	// Inline code written with three backticks on one line does not open a fence.
	const inline = VALID_SPEC.replace("## Verification\n", "```make verify``` is the gate.\n\n## Verification\n");
	assert.deepEqual(run(inline).errors, []);
});

test("link targets may contain parentheses", () => {
	const { root, run } = setup();
	write(root, "docs/a_(b).md", "x");
	const errors = run(VALID_SPEC.replace("See [the plan](../../PLAN.md).", "See [p](../a_(b).md) and [q](../missing_(c).md).")).errors;
	assert.deepEqual(errors.map((e) => e.message), ["Broken link: ../missing_(c).md"]);
});

test("reference-style link definitions are checked too", () => {
	const { run } = setup();
	const spec = VALID_SPEC.replace(
		"See [the plan](../../PLAN.md).",
		"See [the plan][plan], [the web][web] and [a gone file][gone].\n\n[plan]: ../../PLAN.md\n[web]: https://example.test/x\n[gone]: ../../MISSING.md \"title\"",
	);
	assert.deepEqual(run(spec).errors.map((e) => e.message), ["Broken link: ../../MISSING.md"]);
});
