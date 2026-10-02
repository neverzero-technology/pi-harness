import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Exec } from "../src/git.ts";
import type { Issue, IssueRef, WorkflowState } from "../src/linear.ts";

// The suites run against a fake Linear with a team "Engineering" (ENG) and a "Ready" state, whatever the
// team's own team.json says. Everything else (host version, model, git and spec settings) is the real config.
if (!process.env.PI_TEAM_CONFIG) {
	const real = JSON.parse(readFileSync(fileURLToPath(new URL("../team.json", import.meta.url)), "utf8"));
	const file = join(mkdtempSync(join(tmpdir(), "pi-team-config-")), "team.json");
	writeFileSync(
		file,
		JSON.stringify({
			...real,
			linear: { teamName: "Engineering", teamKey: "ENG", states: { backlog: "Backlog", ready: "Ready", inProgress: "In Progress", inReview: "In Review", done: "Done", canceled: "Canceled" }, blockedLabel: "blocked" },
		}),
	);
	process.env.PI_TEAM_CONFIG = file;
}

export const STATES: Record<string, WorkflowState> = {
	backlog: { id: "s-backlog", name: "Backlog", type: "backlog" },
	ready: { id: "s-ready", name: "Ready", type: "unstarted" },
	inProgress: { id: "s-progress", name: "In Progress", type: "started" },
	inReview: { id: "s-review", name: "In Review", type: "started" },
	done: { id: "s-done", name: "Done", type: "completed" },
	canceled: { id: "s-canceled", name: "Canceled", type: "canceled" },
};

export function ref(identifier: string, patch: Partial<IssueRef> = {}): IssueRef {
	return {
		id: `id-${identifier}`,
		identifier,
		title: `Title ${identifier}`,
		url: `https://linear.app/x/issue/${identifier}`,
		state: STATES.ready,
		labels: [],
		...patch,
	};
}

export function issue(identifier: string, patch: Partial<Issue> = {}): Issue {
	return {
		...ref(identifier),
		description: "Acceptance text",
		team: { id: "team-1", key: "ENG" },
		blockers: [],
		blocks: [],
		comments: [],
		attachments: [],
		...patch,
	};
}

export function tempDir(prefix = "pi-team-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	}).trim();
}

export function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

// A repo with a bare "origin" so origin/main exists, as it would in a real clone.
export function repoWithOrigin(): { root: string; origin: string } {
	const origin = tempDir("pi-team-origin-");
	git(origin, "init", "-q", "--bare", "-b", "main");
	const root = tempDir("pi-team-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "remote", "add", "origin", origin);
	write(root, "README.md", "hello\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	git(root, "push", "-q", "-u", "origin", "main");
	return { root, origin };
}

// The profile a test repository carries: what any adopted repository holds in .pi-team/profile.json.
export const PROFILE = {
	name: "acme-app",
	docs: ["AGENTS.md", "PLAN.md"],
	verify: { offline: "./scripts/verify --offline", full: "./scripts/verify", notes: ["The full gate needs Docker; its results are local evidence, not live."] },
	generated: ["templates/generated/**", "api/gen/*client*"],
	invariants: ["Tenancy comes from the tenant record, never from template input.", "Never hand-edit generated output; change the generator and regenerate."],
	pins: [{ file: "release.lock.yaml", producer: "platform" }],
	consumers: ["portal"],
	linear: { label: "repo:acme-app" },
};

// A repository that has adopted the workflow: its profile is merged on the default branch of a local origin.
export function profiledRepo(profile: object | null = PROFILE): { root: string; origin: string } {
	const origin = tempDir("pi-team-origin-");
	git(origin, "init", "-q", "--bare", "-b", "main");
	const root = tempDir("pi-team-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "remote", "add", "origin", origin);
	git(root, "config", "user.name", "Dan");
	git(root, "config", "user.email", "dan@example.test");
	write(root, "README.md", "fixture\n");
	write(root, "PLAN.md", "# plan\n");
	if (profile) write(root, ".pi-team/profile.json", `${JSON.stringify(profile, null, 2)}\n`);
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	git(root, "push", "-q", "-u", "origin", "main");
	return { root, origin };
}

export const realExec: Exec = async (command, args, options) => {
	try {
		const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; status?: number };
		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
	}
};

export const LINT = { capabilitiesDir: "docs/specs", warnWords: 1500, warnRequirements: 15 };

export const VALID_SPEC = `---
id: tenant-identity
linear: ENG-142
capabilities:
  - tenant-onboarding
---

# Tenant identity resolution

## Outcome
Prevent template input from selecting another tenant's deployment boundary.

## Scope and non-goals
Resolve tenant identity server-side. Do not change the identity provider.

## Requirements

### R1 — Tenant resolution
When a deployment is requested, the system must resolve the tenant boundary from the tenant record.

#### Scenario: Authorized request
Given an authorized user, when deployment is requested, then the server uses the record's namespace.

#### Scenario: Conflicting input
Given input naming another tenant, when deployment is requested, then the system rejects it.

### R2 — Audit
When resolution rejects input, the system must log the rejection.

#### Scenario: Rejection logged
Given conflicting input, when it is rejected, then an audit event exists.

## Relevant contracts
See [the plan](../../PLAN.md).

## Verification
R1 allowed and denied cases; R2 audit test.

## Decisions and open questions
- Decision (human): reject rather than ignore conflicting input.
`;
