import assert from "node:assert/strict";
import { test } from "node:test";
import { ADOPT_BRANCH, adoptionPrBody, formatInventory, inventory, parseNameStatus, unaccountedDeletions } from "../src/discover.ts";
import { guardToolCall, type GuardInput } from "../src/modes.ts";
import { PROFILE_PATH } from "../src/profile.ts";
import { git, PROFILE, profiledRepo, write } from "./helpers.ts";
import { host, withGh, withLinear } from "./host.ts";

test("inventory sorts what a repository already has into what adoption must deal with", () => {
	const found = inventory([
		"AGENTS.md", "CLAUDE.md", "services/api/AGENTS.md", ".cursorrules", ".github/copilot-instructions.md",
		".claude/commands/task-new.md", ".claude/settings.json", ".codex/agents/reviewer.toml", ".cursor/rules/app.mdc", ".specify/templates/spec-template.md",
		"prd.md", "spec.md", "PLAN.md", "openspec/changes/add-auth/proposal.md", "specs/001-login/spec.md", "docs/adr/0001-db.md", ".kiro/specs/x/requirements.md",
		"tasks/T001.md", "tasks/README.md", "TODO.md", "scripts/tasks.sh", "docs/STATE.md", ".claude/commands/tasks.md",
		"Makefile", "package.json", "scripts/verify", ".github/workflows/ci.yml", "lefthook.yml", "CODEOWNERS",
		"src/index.ts", "README.md", ".pi-team/profile.json",
	]);
	assert.deepEqual(found.instructions, [".cursorrules", ".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "services/api/AGENTS.md"]);
	assert.deepEqual(found.harness, [".claude/commands/task-new.md", ".claude/commands/tasks.md", ".claude/settings.json", ".codex/agents/reviewer.toml", ".cursor/rules/app.mdc", ".specify/templates/spec-template.md"]);
	assert.deepEqual(found.specs, [".kiro/specs/x/requirements.md", "PLAN.md", "docs/adr/0001-db.md", "openspec/changes/add-auth/proposal.md", "prd.md", "spec.md", "specs/001-login/spec.md"]);
	assert.deepEqual(found.ledgers, ["TODO.md", "docs/STATE.md", "scripts/tasks.sh", "tasks/README.md", "tasks/T001.md"]);
	assert.deepEqual(found.verification, ["Makefile", "package.json", "scripts/verify"]);
	assert.deepEqual(found.ci, [".github/workflows/ci.yml"]);
	assert.deepEqual(found.hooks, ["lefthook.yml"]);
	assert.deepEqual(found.ownership, ["CODEOWNERS"]);
	assert.ok(!Object.values(found).flat().includes("src/index.ts"));
	assert.ok(!Object.values(found).flat().includes(".pi-team/profile.json"), "the workflow's own files are not old material");

	const many = inventory([...Array.from({ length: 60 }, (_, i) => `tasks/T${String(i).padStart(3, "0")}.md`), "scripts/tasks.sh", "docs/STATE.md"]);
	assert.match(formatInventory(many), /Task and progress ledgers: \n- tasks\/ \(60 files\)\n- docs\/STATE\.md\n- scripts\/tasks\.sh/, "big directories are collapsed, everything else is named");
	assert.match(formatInventory(many), /Agent harness configuration \(roles, commands, rules, settings\): none found/);
});

test("every deletion must be accounted for, by path or by directory", () => {
	const changes = parseNameStatus(["A\t.pi-team/profile.json", "M\tAGENTS.md", "D\ttasks/T001.md", "D\ttasks/T002.md", "D\t.codex/agents/reviewer.toml", "D\tprd.md", "R090\tdocs/old.md\tdocs/new.md", "D\tscripts/tasks.sh"].join("\n"));
	assert.deepEqual(changes[6], { status: "R", path: "docs/old.md", to: "docs/new.md" });
	assert.deepEqual(unaccountedDeletions(changes, undefined), ["tasks/T001.md", "tasks/T002.md", ".codex/agents/reviewer.toml", "prd.md", "scripts/tasks.sh"]);
	const report = {
		summary: "s",
		migrated: [{ from: "tasks/", to: "Linear" }, { from: "prd.md", to: "docs/changes/billing.md" }],
		removed: [{ path: ".codex", reason: "roles are replaced by the workflow" }],
		followUps: [],
	};
	assert.deepEqual(unaccountedDeletions(changes, report), ["scripts/tasks.sh"], "a directory covers its files; a look-alike prefix does not");
	assert.deepEqual(unaccountedDeletions(changes, { ...report, removed: [...report.removed, { path: "scripts/tasks.sh", reason: "ledger script" }] }), []);
	assert.deepEqual(unaccountedDeletions(parseNameStatus("D\ttasks-old/x.md"), report), ["tasks-old/x.md"]);
});

test("the pull request description is built from the facts", () => {
	const body = adoptionPrBody({
		profileName: "acme-app",
		changes: parseNameStatus("A\t.pi-team/profile.json\nM\tAGENTS.md\nD\tprd.md\nD\ttasks/T001.md"),
		verifyOffline: "make check",
		invariants: 6,
		generated: 2,
		state: {
			report: { summary: "Had a task ledger and Codex roles.", migrated: [{ from: "prd.md", to: "docs/changes/billing.md" }], removed: [{ path: "tasks/", reason: "open tasks are in Linear" }], followUps: ["Confirm the full gate"] },
			project: { name: "Acme", url: "https://linear.example/project/Acme", created: true, issues: [{ source: "tasks/T001.md", identifier: "ENG-101", url: "https://linear.example/ENG-101", created: true }] },
		},
	});
	for (const expected of [
		"Adopts the pi-team workflow for `acme-app`.",
		"Had a task ledger and Codex roles.",
		"1 file(s) added, 1 changed, 0 moved, 2 removed.",
		"6 invariant(s), 2 generated-path pattern(s), offline gate `make check`",
		"## Migrated\n- `prd.md` → docs/changes/billing.md",
		"## Removed without replacement\n- `tasks/`: open tasks are in Linear",
		"Project [Acme](https://linear.example/project/Acme) (created): 1 issue(s), 1 created by this adoption.",
		"- [ENG-101](https://linear.example/ENG-101) from `tasks/T001.md`",
		"## Follow-ups\n- Confirm the full gate",
		"## Review checklist",
	]) {
		assert.ok(body.includes(expected), `${expected}\n---\n${body}`);
	}
	const bare = adoptionPrBody({ profileName: "x", changes: [], verifyOffline: "t", invariants: 0, generated: 0, state: {} });
	assert.match(bare, /No Linear project was populated/);
	assert.doesNotMatch(bare, /\n\n\n/);
});

test("the profile is writable only during /discover, and discover never touches product source", () => {
	const base: GuardInput = { mode: "implement", toolName: "write", input: { path: PROFILE_PATH }, cwd: "/repo", repoRoot: "/repo", generated: [], specDirs: ["docs"] };
	const run = (patch: Partial<GuardInput>) => guardToolCall({ ...base, ...patch }).action;
	assert.equal(run({}), "block");
	assert.equal(run({ mode: "spec" }), "block");
	assert.equal(run({ mode: "review" }), "block");
	assert.equal(run({ toolName: "edit", input: { path: "@.PI-TEAM/profile.json" } }), "block");
	assert.equal(run({ mode: "discover" }), "allow");
	for (const path of ["AGENTS.md", "docs/changes/billing.md", ".github/pull_request_template.md", ".pi-team/profile.json"]) {
		assert.equal(run({ mode: "discover", input: { path } }), "allow", path);
	}
	for (const path of ["src/index.ts", "Makefile", "package.json", "scripts/verify", "services/api/AGENTS.md"]) {
		assert.equal(run({ mode: "discover", input: { path } }), "block", path);
	}
	assert.equal(run({ mode: "discover", generated: ["docs/generated/**"], input: { path: "docs/generated/api.md" } }), "block", "generated files stay protected");
	for (const tool of ["team_discover_report", "team_project_populate"]) {
		assert.equal(run({ toolName: tool, input: {} }), "block", tool);
		assert.equal(run({ mode: "discover", toolName: tool, input: {} }), "allow", tool);
	}
	assert.equal(run({ mode: "discover", toolName: "team_checkpoint", input: {} }), "block");
});

// A repository as it might look before adoption: another harness, a PRD, a task ledger.
function legacyRepo() {
	const repo = profiledRepo(null);
	write(repo.root, "AGENTS.md", "# App\n\nUse /task-start before working. Tenancy comes from the tenant record.\n");
	write(repo.root, "CLAUDE.md", "# App\n\nUse /task-start before working. Tenancy comes from the tenant record.\n");
	write(repo.root, ".claude/commands/task-start.md", "Start a task from tasks/.\n");
	write(repo.root, ".codex/agents/reviewer.toml", "role = 'reviewer'\n");
	write(repo.root, "prd.md", "# Billing\n\nCustomers can download invoices.\n");
	write(repo.root, "tasks/T001.md", "---\nstatus: done\n---\nSet up the repo\n");
	write(repo.root, "tasks/T002.md", "---\nstatus: in-progress\nowner: sam\n---\nInvoice PDF endpoint\n");
	write(repo.root, "tasks/T003.md", "---\nstatus: todo\ndepends: T002\n---\nEmail invoices\n");
	write(repo.root, "Makefile", "verify:\n\ttrue\n");
	write(repo.root, "src/index.ts", "export {};\n");
	git(repo.root, "add", "-A");
	git(repo.root, "commit", "-qm", "legacy");
	git(repo.root, "push", "-q", "origin", "main");
	return repo;
}

async function session(root: string) {
	const h = host(root);
	await h.emit("session_start", { type: "session_start", reason: "startup" });
	const discover = (args = "") => h.commands.get("discover")!.handler(args, h.ctx);
	const tool = (name: string, params: unknown) => h.tools.get(name).execute("call", params, undefined, undefined, h.ctx);
	const report = () => h.messages.map((m) => String(m.content)).join("\n");
	return { h, discover, tool, report };
}

// What the agent does during the scan, done by hand here.
function adopt(root: string) {
	write(root, PROFILE_PATH, `${JSON.stringify({ ...PROFILE, pins: [], consumers: [] }, null, 2)}\n`);
	write(root, "AGENTS.md", "# App\n\nRules and verification: .pi-team/profile.json.\n");
	write(root, "docs/changes/billing.md", "---\nid: billing\nlinear: ENG-1\n---\n# Billing\n");
	git(root, "rm", "-q", "-r", "CLAUDE.md", ".claude", ".codex", "prd.md", "tasks");
}

const REPORT = {
	summary: "The repository used Claude commands, Codex roles and a task ledger.",
	migrated: [{ from: "prd.md", to: "docs/changes/billing.md" }, { from: "tasks/", to: "Linear project Acme" }],
	removed: [{ path: ".claude", reason: "task commands are replaced by /work" }, { path: ".codex", reason: "roles are replaced by the workflow" }, { path: "CLAUDE.md", reason: "it mirrored AGENTS.md" }],
	followUps: ["Confirm make verify is the only gate"],
};

const PROPOSAL = {
	project: { name: "Acme", description: "Invoices for customers." },
	issues: [
		{ source: "tasks/T002.md", title: "Invoice PDF endpoint", description: "Customers download an invoice as PDF.\n\nPreviously in progress, owner sam.", state: "ready", dependsOn: [] },
		{ source: "tasks/T003.md", title: "Email invoices", description: "Invoices are emailed monthly.", state: "ready", dependsOn: ["tasks/T002.md"] },
	],
};

test("/discover starts the adoption on its own branch with the inventory and the method", async () => {
	await withLinear(async () => {
		const { root } = legacyRepo();
		const { h, discover, report } = await session(root);
		assert.match(h.notices.join("\n"), /has not adopted the workflow yet .* Run \/discover/);

		write(root, "wip.txt", "x");
		await discover();
		assert.match(h.notices.at(-1)!, /Commit or stash your changes first/);
		assert.equal(git(root, "branch", "--show-current"), "main");
		git(root, "clean", "-qf");

		await discover();
		assert.equal(git(root, "branch", "--show-current"), ADOPT_BRANCH);
		assert.equal(git(root, "config", "--get", "--default", "none", `branch.${ADOPT_BRANCH}.merge`), "none", "the adoption branch does not track main");
		assert.match(h.status.get("pi-team")!, /discover$/);
		assert.deepEqual(h.thinking, ["high"]);
		assert.match(report(), /This repository has no profile yet/);
		assert.match(report(), /Agent harness configuration \(roles, commands, rules, settings\): \n- \.claude\/commands\/task-start\.md\n- \.codex\/agents\/reviewer\.toml/);
		assert.match(report(), /Task and progress ledgers: \n- tasks\/T001\.md/);
		const prompt = h.userMessages.at(-1)!;
		assert.match(prompt, /skills\/discovery\/SKILL\.md/);
		assert.match(prompt, /Write \.pi-team\/profile\.json in this shape \(suggested name: "pi-team-origin-/);
		assert.match(prompt, /"verify": \{/);
		assert.match(prompt, /Do not create anything in Linear in this step/);

		// Running it again continues on the same branch rather than starting over.
		write(root, PROFILE_PATH, "{}");
		await discover();
		assert.equal(git(root, "branch", "--show-current"), ADOPT_BRANCH);
	});
});

test("the adoption report must cover every deletion before a pull request is raised", async () => {
	await withLinear(async () => {
		await withGh(async (gh) => {
			const { root, origin } = legacyRepo();
			const { h, discover, tool, report } = await session(root);
			await discover();
			adopt(root);

			const partial = await tool("team_discover_report", { ...REPORT, removed: REPORT.removed.slice(0, 1) });
			assert.equal(partial.isError, true);
			assert.match(partial.content[0].text, /not covered by it:\n- \.codex\/agents\/reviewer\.toml\n- CLAUDE\.md/);

			await discover("status");
			assert.match(report(), /not ready for a pull request/);
			assert.match(report(), /✗ \d+ uncommitted file\(s\)/);

			git(root, "add", "-A");
			git(root, "commit", "-qm", "Adopt the workflow");
			await discover("pr");
			assert.match(report(), /\/discover pr: not ready\n✗ Deleted without being listed as migrated or removed in the report: \.codex\/agents\/reviewer\.toml, CLAUDE\.md/);
			assert.equal(git(origin, "branch", "--list", ADOPT_BRANCH), "");
			assert.equal(h.confirms.length, 0);

			const complete = await tool("team_discover_report", REPORT);
			assert.equal(complete.isError, undefined);
			assert.match(complete.content[0].text, /2 migrated, 3 removed, 1 follow-up\(s\)\. Every deletion is accounted for/);
			await discover("status");
			assert.match(report(), /\/discover: ready for \/discover pr\n\? Generated-path patterns that match no tracked file[^\n]*\n\? No Linear project populated/);

			h.answers.confirm = false;
			await discover("pr");
			assert.equal(git(origin, "branch", "--list", ADOPT_BRANCH), "", "declining pushes nothing");
			h.answers.confirm = true;
			await discover("pr");
			assert.equal(git(origin, "rev-parse", ADOPT_BRANCH), git(root, "rev-parse", "HEAD"));
			const args = gh.created()!;
			assert.ok(!args.includes("--draft"), "the adoption is raised for review, not as a draft");
			assert.deepEqual(args.slice(0, 8), ["pr", "create", "--head", ADOPT_BRANCH, "--base", "main", "--title", "Adopt the pi-team workflow"]);
			const body = args.join("\n");
			assert.match(body, /## Migrated\n- `prd\.md` → docs\/changes\/billing\.md/);
			assert.match(body, /## Removed without replacement\n- `\.claude`: task commands are replaced by \/work/);
			assert.match(body, /No Linear project was populated/);
			assert.match(report(), /Opened pull request: https:\/\/github\.example\/pr\/99\nThe profile takes effect when the pull request merges into origin\/main/);
		});
	});
});

test("the profile must point at real documents, and unmatched generated patterns are called out", async () => {
	await withLinear(async () => {
		await withGh(async () => {
			const { root } = legacyRepo();
			const { discover, tool, report } = await session(root);
			await discover();
			adopt(root);
			write(root, PROFILE_PATH, JSON.stringify({ ...PROFILE, pins: [], consumers: [], docs: ["AGENTS.md", "docs/ARCHITECTURE.md"], generated: ["bin/**", "docs/changes/*.md"] }));
			git(root, "add", "-A");
			git(root, "commit", "-qm", "Adopt");
			await tool("team_discover_report", REPORT);
			await discover("status");
			assert.match(report(), /✗ The profile lists documents that are not in the repository: docs\/ARCHITECTURE\.md/);
			assert.match(report(), /\? Generated-path patterns that match no tracked file \(they should name checked-in generated files, not build output\): bin\/\*\*/);
			assert.doesNotMatch(report(), /match no tracked file[^\n]*docs\/changes/);
		});
	});
});

test("a broken or missing profile, or work on the wrong branch, stops the pull request", async () => {
	await withLinear(async () => {
		await withGh(async () => {
			const { root } = legacyRepo();
			const { discover, tool, report } = await session(root);
			await discover("pr");
			assert.match(report(), /✗ Not on pi-team\/adopt/);
			await discover();
			git(root, "rm", "-q", "prd.md");
			git(root, "commit", "-qm", "wip");
			await tool("team_discover_report", { ...REPORT, migrated: [{ from: "prd.md", to: "docs" }], removed: [] });
			await discover("pr");
			assert.match(report(), /✗ \.pi-team\/profile\.json has not been written/);
			write(root, PROFILE_PATH, JSON.stringify({ name: "acme app" }));
			git(root, "add", "-A");
			git(root, "commit", "-qm", "bad profile");
			await discover("pr");
			assert.match(report(), /✗ \.pi-team\/profile\.json is invalid: "name" is required/);
		});
	});
});

test("the Linear project is created once, from a confirmed preview, and re-runs reuse it", async () => {
	await withLinear(async (linear) => {
		await withGh(async (gh) => {
			const { root } = legacyRepo();
			const { h, discover, tool, report } = await session(root);
			await discover();
			const early = await tool("team_project_populate", PROPOSAL);
			assert.match(early.content[0].text, /Write a valid \.pi-team\/profile\.json first/);
			adopt(root);

			h.answers.confirm = false;
			assert.match((await tool("team_project_populate", PROPOSAL)).content[0].text, /declined; nothing was created/);
			assert.equal(linear.projects.length + linear.issues.size, 0);

			h.answers.confirm = true;
			const made = await tool("team_project_populate", PROPOSAL);
			assert.equal(made.isError, undefined, made.content[0].text);
			assert.match(h.confirms.at(-1)!.title, /Create a Linear project and 2 issue\(s\)\?/);
			assert.match(h.confirms.at(-1)!.message, /Create project "Acme": Invoices for customers\.\nReuse 0 issue\(s\):\nCreate 2 issue\(s\):\n- \[ready\] Invoice PDF endpoint \(tasks\/T002\.md\)/);
			assert.deepEqual(linear.projects.map((p) => p.name), ["Acme"]);
			const [pdf, email] = [...linear.issues.values()];
			assert.equal(pdf.state, "Ready");
			assert.equal(email.state, "Backlog", "an issue with an open dependency is not ready");
			assert.equal(pdf.assignee, undefined, "nobody is assigned on their behalf");
			assert.equal(pdf.project, "Acme");
			assert.deepEqual(pdf.labels, ["repo:acme-app"]);
			assert.match(pdf.description, /Previously in progress, owner sam\.\n\n---\n\*\*pi-team\*\*\n- repo: `acme-app`\n- source: `tasks\/T002\.md`$/);
			assert.deepEqual(linear.relations, [{ blocker: pdf.id, blocked: email.id }]);

			// A second run, with one more item, creates only the new one.
			const more = { ...PROPOSAL, issues: [...PROPOSAL.issues, { source: "prd.md#export", title: "CSV export", description: "Export invoices.", state: "backlog", dependsOn: [] }] };
			const again = await tool("team_project_populate", more);
			assert.match(again.content[0].text, /Reuse project "Acme"\nReuse 2 issue\(s\):[\s\S]*Create 1 issue\(s\):\n- \[backlog\] CSV export/);
			assert.equal(linear.issues.size, 3);
			assert.equal(linear.projects.length, 1);
			assert.match((await tool("team_project_populate", more)).content[0].text, /Nothing to create/);
			assert.equal(linear.issues.size, 3);

			// A write lost in transit is recovered by running again.
			linear.failNext = { match: "issueCreate", mode: "lost" };
			const lost = await tool("team_project_populate", { ...more, issues: [...more.issues, { source: "prd.md#tax", title: "Tax", description: "VAT.", state: "backlog", dependsOn: [] }] });
			assert.equal(lost.isError, true);
			assert.match(lost.content[0].text, /may or may not have been applied/);
			await tool("team_project_populate", { ...more, issues: [...more.issues, { source: "prd.md#tax", title: "Tax", description: "VAT.", state: "backlog", dependsOn: [] }] });
			assert.equal(linear.issues.size, 4, "the lost write had landed and was not repeated");

			// Proposals that cannot work are rejected before anything is asked.
			const bad = await tool("team_project_populate", { project: { name: " ", description: "" }, issues: [{ ...PROPOSAL.issues[0], dependsOn: ["tasks/T999.md"] }, PROPOSAL.issues[0], { ...PROPOSAL.issues[1], source: "bad `key`", title: "" }] });
			assert.equal(bad.isError, true);
			for (const expected of [/Duplicate source tasks\/T002\.md/, /depends on tasks\/T999\.md, which is not another issue/, /is not a usable source reference/, /has no title/, /The project needs a name/]) {
				assert.match(bad.content[0].text, expected);
			}

			// The project and its issues appear in the pull request.
			git(root, "add", "-A");
			git(root, "commit", "-qm", "Adopt the workflow");
			await tool("team_discover_report", REPORT);
			await discover("pr");
			const body = gh.created()!.join("\n");
			assert.match(body, /Project \[Acme\]\(https:\/\/linear\.example\/project\/Acme\) \(created\): 4 issue\(s\), 3 created by this adoption\./);
			assert.match(body, /- \[ENG-\d+\]\(https:\/\/linear\.example\/ENG-\d+\) from `tasks\/T002\.md`/);
			assert.match(report(), /Opened pull request/);
		});
	});
});

test("once merged, the profile rules every session and the agent cannot edit it", async () => {
	await withLinear(async () => {
		const { root } = legacyRepo();
		const first = await session(root);
		await first.discover();
		adopt(root);
		git(root, "add", "-A");
		git(root, "commit", "-qm", "Adopt the workflow");

		// On the adoption branch the working-tree profile is used, and doctor says it is not merged.
		const adopting = await session(root);
		assert.match(adopting.h.status.get("pi-team")!, /^acme-app · /);
		const call = (h: Awaited<ReturnType<typeof session>>["h"], path: string) => h.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "write", input: { path } });
		assert.equal((await call(adopting.h, "templates/generated/x.yaml"))?.block, true, "the profile's generated paths are enforced");

		// Merge it.
		git(root, "push", "-q", "origin", `${ADOPT_BRANCH}:main`);
		git(root, "switch", "-q", "main");
		git(root, "pull", "-q", "origin", "main");
		const merged = await session(root);
		assert.match(merged.h.status.get("pi-team")!, /^acme-app · /);
		assert.equal(merged.h.notices.length, 0);
		const blocked = await call(merged.h, PROFILE_PATH);
		assert.equal(blocked?.block, true);
		assert.match(blocked.reason, /change it with \/discover and a reviewed pull request/);

		// A local edit that drops the generated paths changes nothing.
		write(root, PROFILE_PATH, JSON.stringify({ ...PROFILE, generated: [] }));
		const tampered = await session(root);
		assert.equal((await call(tampered.h, "templates/generated/x.yaml"))?.block, true);
	});
});
