import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./config.ts";

// Adoption of the workflow by an existing repository: find what is there, account for everything that
// is replaced, and describe the result for the people reviewing the pull request.

export const ADOPT_BRANCH = "pi-team/adopt";

export interface Inventory {
	instructions: string[];
	harness: string[];
	specs: string[];
	ledgers: string[];
	verification: string[];
	ci: string[];
	hooks: string[];
	ownership: string[];
}

// Each category lists the conventions of the common agent harnesses and spec tools. Unknown layouts are
// still found by the agent reading the repository; this is the deterministic starting point.
const CATEGORIES: Record<keyof Inventory, { what: string; globs: string[] }> = {
	instructions: {
		what: "Agent instruction files",
		globs: ["AGENTS.md", "**/AGENTS.md", "CLAUDE.md", "**/CLAUDE.md", "GEMINI.md", "CONVENTIONS.md", "HARNESS.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"],
	},
	harness: {
		what: "Agent harness configuration (roles, commands, rules, settings)",
		globs: [".claude/**", ".codex/**", ".cursor/**", ".pi/**", ".agents/**", ".continue/**", ".roo/**", ".aider*", ".kiro/steering/**", ".kiro/hooks/**", ".specify/**", ".tessl/**", "openspec/AGENTS.md", "openspec/project.md"],
	},
	specs: {
		what: "Specifications, PRDs, plans and decision records",
		globs: [
			"openspec/specs/**", "openspec/changes/**", "specs/**", ".kiro/specs/**", "docs/specs/**", "docs/changes/**", "docs/plans/**", "docs/prd/**", "docs/prds/**",
			"docs/adr/**", "docs/adrs/**", "docs/decisions/**", "docs/rfcs/**", "docs/design/**", "PRD.md", "prd.md", "PRD-*.md", "SPEC.md", "spec.md", "**/SPEC.md", "PLAN.md", "plan.md", "ROADMAP.md", "docs/architecture*", "ARCHITECTURE.md",
		],
	},
	ledgers: {
		what: "Task and progress ledgers",
		globs: ["tasks/**", "TODO.md", "todo.md", "TASKS.md", "tasks.md", "**/tasks.md", "PROGRESS.md", "STATUS.md", "docs/STATE.md", "docs/progress*", "backlog/**", ".beads/**", "scripts/tasks*"],
	},
	verification: {
		what: "Verification entry points",
		globs: ["Makefile", "makefile", "justfile", "Justfile", "Taskfile.yml", "Taskfile.yaml", "package.json", "pyproject.toml", "tox.ini", "noxfile.py", "go.mod", "Cargo.toml", "scripts/verify*", "scripts/test*", "scripts/check*", "scripts/lint*"],
	},
	ci: { what: "CI configuration", globs: [".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**", "azure-pipelines.yml", "Jenkinsfile"] },
	hooks: { what: "Git hooks", globs: ["lefthook.yml", "lefthook.yaml", ".husky/**", ".pre-commit-config.yaml"] },
	ownership: { what: "Ownership and PR conventions", globs: ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".github/pull_request_template.md", "CONTRIBUTING.md"] },
};

export function inventory(trackedFiles: string[]): Inventory {
	const result = {} as Inventory;
	// A file belongs to the first category that claims it, so a harness command named tasks.md is not also a ledger.
	const claimed = new Set<string>();
	for (const [key, { globs }] of Object.entries(CATEGORIES) as [keyof Inventory, { globs: string[] }][]) {
		const patterns = globs.map(globToRegExp);
		result[key] = trackedFiles.filter((file) => !file.startsWith(".pi-team/") && !claimed.has(file) && patterns.some((p) => p.test(file))).sort();
		for (const file of result[key]) claimed.add(file);
	}
	return result;
}

// Long lists are shown by directory with a count, so a ledger of hundreds of files stays readable.
export function formatInventory(found: Inventory, limit = 25): string {
	const lines: string[] = [];
	for (const [key, { what }] of Object.entries(CATEGORIES) as [keyof Inventory, { what: string }][]) {
		const files = found[key];
		lines.push(`${what}: ${files.length ? "" : "none found"}`);
		if (files.length <= limit) lines.push(...files.map((f) => `- ${f}`));
		else {
			// Only directories with many files are collapsed; everything else is still named.
			const perDir = new Map<string, number>();
			for (const file of files) perDir.set(file.split("/")[0], (perDir.get(file.split("/")[0]) ?? 0) + 1);
			const collapsed = new Set([...perDir].filter(([dir, count]) => count >= 8 && files.some((f) => f.startsWith(`${dir}/`))).map(([dir]) => dir));
			lines.push(...[...collapsed].map((dir) => `- ${dir}/ (${perDir.get(dir)} files)`));
			lines.push(...files.filter((f) => !collapsed.has(f.split("/")[0])).map((f) => `- ${f}`));
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export interface DiscoverReport {
	summary: string;
	// Old material and where its content now lives.
	migrated: { from: string; to: string }[];
	// Old material deleted on purpose, with the reason nothing replaces it.
	removed: { path: string; reason: string }[];
	followUps: string[];
}

export interface PopulatedProject {
	name: string;
	url: string;
	created: boolean;
	issues: { source: string; identifier: string; url: string; created: boolean }[];
}

export interface DiscoverState {
	// The Linear project the human chose for this repository, before anything is proposed.
	projectName?: string;
	report?: DiscoverReport;
	project?: PopulatedProject;
}

// Kept beside the other local workflow state, outside the working tree.
export class DiscoverStore {
	private readonly file: string;

	constructor(gitCommonDir: string) {
		this.file = join(gitCommonDir, "pi-team", "discover.json");
	}

	read(): DiscoverState {
		try {
			return JSON.parse(readFileSync(this.file, "utf8")) as DiscoverState;
		} catch {
			return {};
		}
	}

	update(patch: Partial<DiscoverState>): DiscoverState {
		const next = { ...this.read(), ...patch };
		mkdirSync(join(this.file, ".."), { recursive: true });
		writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	}
}

export interface FileChange {
	status: "A" | "M" | "D" | "R";
	path: string;
	to?: string; // rename target
}

// `git diff --name-status -M` output.
export function parseNameStatus(output: string): FileChange[] {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path, to] = line.split("\t");
			return { status: status[0] as FileChange["status"], path, to };
		});
}

const covers = (entry: string, path: string) => {
	const prefix = entry.replace(/\/+$/, "");
	return path === prefix || path.startsWith(`${prefix}/`);
};

// Nothing may disappear silently: every deleted file must be named in the report, directly or by its
// directory, as migrated somewhere or removed for a stated reason. Renames carry their content with them.
export function unaccountedDeletions(changes: FileChange[], report: DiscoverReport | undefined): string[] {
	const accounted = [...(report?.migrated.map((m) => m.from) ?? []), ...(report?.removed.map((r) => r.path) ?? [])];
	return changes.filter((c) => c.status === "D" && !accounted.some((entry) => covers(entry, c.path))).map((c) => c.path);
}

export function adoptionPrBody(options: { profileName: string; changes: FileChange[]; state: DiscoverState; verifyOffline: string; invariants: number; generated: number }): string {
	const { changes, state } = options;
	const count = (status: string) => changes.filter((c) => c.status === status).length;
	const report = state.report;
	const lines = [
		`Adopts the pi-team workflow for \`${options.profileName}\`.`,
		"",
		report?.summary ?? "",
		"",
		"## What changes",
		`${count("A")} file(s) added, ${count("M")} changed, ${count("R")} moved, ${count("D")} removed.`,
		"",
		`- \`.pi-team/profile.json\` now holds this repository's rules for the workflow: ${options.invariants} invariant(s), ${options.generated} generated-path pattern(s), offline gate \`${options.verifyOffline}\`.`,
		"- It takes effect for everyone when this pull request merges; later changes to it also need a merged pull request.",
		"",
	];
	if (report?.migrated.length) lines.push("## Migrated", ...report.migrated.map((m) => `- \`${m.from}\` → ${m.to}`), "");
	if (report?.removed.length) lines.push("## Removed without replacement", ...report.removed.map((r) => `- \`${r.path}\`: ${r.reason}`), "");
	if (state.project) {
		const created = state.project.issues.filter((i) => i.created).length;
		lines.push(
			"## Linear",
			`Project [${state.project.name}](${state.project.url})${state.project.created ? " (created)" : ""}: ${state.project.issues.length} issue(s), ${created} created by this adoption.`,
			...state.project.issues.map((i) => `- [${i.identifier}](${i.url}) from \`${i.source}\``),
			"",
		);
	} else {
		lines.push("## Linear", "No Linear project was populated as part of this adoption.", "");
	}
	if (report?.followUps.length) lines.push("## Follow-ups", ...report.followUps.map((f) => `- ${f}`), "");
	lines.push(
		"## Review checklist",
		"- [ ] The invariants in the profile are the rules this repository actually enforces, in its own words",
		"- [ ] The verify commands run, and the notes say which evidence is local, simulated, CI or live",
		"- [ ] Generated-path patterns cover every generated file and nothing hand-written",
		"- [ ] Everything under \"Removed without replacement\" is safe to lose",
		"- [ ] Migrated specifications and Linear issues say what the originals said",
	);
	return lines.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}
