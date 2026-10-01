import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asList, parseFrontmatter } from "./frontmatter.ts";

// Structural checks only. Passing lint means the spec is well-formed, not that it is right.

export const REQUIRED_SECTIONS = [
	"Outcome",
	"Scope and non-goals",
	"Requirements",
	"Verification",
	"Decisions and open questions",
] as const;

const RECOMMENDED_SECTIONS = ["Relevant contracts"] as const;

const REQUIREMENT_HEADING = /^###\s+(?:(Added|Modified|Removed):\s*)?([A-Z][A-Z0-9-]*\d+)\s*(?:—|–|-|:)\s*(.+)$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export type DeltaKind = "Added" | "Modified" | "Removed" | undefined;

export interface Requirement {
	id: string;
	title: string;
	delta: DeltaKind;
	line: number;
	scenarios: number;
}

export interface Finding {
	line: number;
	message: string;
}

export interface SpecInfo {
	path: string;
	id: string | undefined;
	linear: string | undefined;
	owner: string | undefined;
	capabilities: string[];
	title: string | undefined;
	requirements: Requirement[];
	blocking: Finding[];
	words: number;
}

export interface LintResult {
	spec: SpecInfo;
	errors: Finding[];
	warnings: Finding[];
}

export interface LintOptions {
	repoRoot: string;
	capabilitiesDir: string;
	warnWords: number;
	warnRequirements: number;
}

export function repositoryFilePath(file: string, root: string): string | undefined {
	try {
		const canonical = realpathSync(file);
		const within = relative(realpathSync(root), canonical);
		if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
		return canonical;
	} catch { return undefined; }
}

export function lintSpecFile(path: string, options: LintOptions): LintResult {
	const file = repositoryFilePath(path, options.repoRoot);
	if (!file) throw new Error("Specification must be a file inside the repository; external paths and symlink escapes are blocked");
	return lintSpec(readFileSync(file, "utf8"), path, options);
}

export function lintSpec(text: string, path: string, options: LintOptions): LintResult {
	const errors: Finding[] = [];
	const warnings: Finding[] = [];
	const doc = parseFrontmatter(text);
	for (const message of doc.errors) errors.push({ line: 1, message });

	const fm = doc.frontmatter;
	if (!fm) errors.push({ line: 1, message: "Missing YAML frontmatter (id, linear, capabilities)" });
	const id = typeof fm?.id === "string" ? fm.id : undefined;
	const linear = typeof fm?.linear === "string" ? fm.linear : undefined;
	const owner = typeof fm?.owner === "string" ? fm.owner : undefined;
	const capabilities = asList(fm?.capabilities);
	if (fm && !id) errors.push({ line: 1, message: "Frontmatter needs `id`" });
	if (fm && !linear) errors.push({ line: 1, message: "Frontmatter needs `linear` (the epic or lead issue key)" });
	if (linear && !ISSUE_KEY.test(linear)) errors.push({ line: 1, message: `\`linear: ${linear}\` is not an issue key` });
	if (id && basename(path, ".md") !== id) {
		warnings.push({ line: 1, message: `File name does not match id \`${id}\`` });
	}

	const lines = doc.body.split("\n");
	const offset = doc.bodyStartLine;
	const sections = new Map<string, number>();
	const requirements: Requirement[] = [];
	const blocking: Finding[] = [];
	let title: string | undefined;
	let section: string | undefined;
	let current: Requirement | undefined;
	let fence: string | undefined;
	let fenceLine = 0;

	lines.forEach((source, index) => {
		const line = index + offset;
		const raw = source.replace(/\r$/, "");
		// Fenced code (``` or ~~~) is content, not structure. A fence closes only with its own marker.
		// A line such as ```inline``` that closes its own backticks is inline code, not a fence.
		const opener = /^\s*(```|~~~)(.*)$/.exec(raw);
		const marker = opener && !opener[2].includes(opener[1]) ? opener[1] : undefined;
		if (marker && (!fence || fence === marker)) {
			fence = fence ? undefined : marker;
			fenceLine = line;
			return;
		}
		if (fence) return;

		const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(raw);
		if (h1 && !title) title = h1[1].trim();

		const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(raw);
		if (h2) {
			section = h2[1].trim();
			current = undefined;
			if (sections.has(section)) errors.push({ line, message: `Duplicate section "${section}"` });
			sections.set(section, line);
			return;
		}

		if (section === "Requirements" && /^###\s/.test(raw)) {
			const match = REQUIREMENT_HEADING.exec(raw);
			if (!match) {
				errors.push({ line, message: `Requirement heading needs an ID, e.g. "### R1 — Title" or "### Modified: TEN-01 — Title"` });
				current = undefined;
				return;
			}
			const [, delta, reqId, reqTitle] = match;
			if (requirements.some((r) => r.id === reqId)) errors.push({ line, message: `Duplicate requirement ID ${reqId}` });
			current = { id: reqId, title: reqTitle.trim(), delta: delta as DeltaKind, line, scenarios: 0 };
			requirements.push(current);
			return;
		}

		if (current && /^####\s+Scenario\b/i.test(raw)) current.scenarios++;

		// Only an item that starts with the marker blocks: "No BLOCKING questions remain" or a struck-through item does not.
		// Bullets, numbered items, task-list boxes, quotes and emphasis are all accepted around the marker.
		if (section === "Decisions and open questions" && /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?[*_]{0,2}BLOCKING[*_]{0,2}\s*:/.test(raw)) {
			blocking.push({ line, message: raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "") });
		}

		if (/<[a-z][a-z0-9 |_-]*>|\bTODO\b|\bTBD\b/i.test(raw.replace(/`[^`]*`/g, ""))) {
			warnings.push({ line, message: "Unresolved placeholder" });
		}

		// Inline links only, outside inline code; a title or angle brackets around the target are allowed.
		const prose = raw.replace(/`[^`]*`/g, "");
		// The target may contain one level of balanced parentheses, as in a_(b).md.
		for (const link of prose.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g)) {
			const target = link[1].replace(/^<|>$/g, "");
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
			// `handlers[0](event)` is code, not a link: a file target has a slash or an extension.
			if (!/[/.]/.test(target)) continue;
			let file = target.split("#")[0];
			try {
				file = decodeURI(file);
			} catch {
				// keep the literal target
			}
			const resolved = file.startsWith("/") ? join(options.repoRoot, file) : resolve(dirname(path), file);
			if (!existsSync(resolved)) errors.push({ line, message: `Broken link: ${target}` });
		}
	});

	// Everything after an unclosed fence is invisible to these checks, including a BLOCKING item.
	if (fence) errors.push({ line: fenceLine, message: `Code fence opened here is never closed` });

	for (const name of REQUIRED_SECTIONS) {
		if (!sections.has(name)) errors.push({ line: offset, message: `Missing section "## ${name}"` });
	}
	for (const name of RECOMMENDED_SECTIONS) {
		if (!sections.has(name)) warnings.push({ line: offset, message: `No "## ${name}" section; link the authoritative contracts` });
	}
	if (sections.has("Requirements") && requirements.length === 0) {
		errors.push({ line: sections.get("Requirements")!, message: "No requirements" });
	}
	for (const req of requirements) {
		if (req.delta !== "Removed" && req.scenarios === 0) {
			errors.push({ line: req.line, message: `${req.id} has no "#### Scenario"` });
		}
	}

	checkBaselines(requirements, capabilities, options, errors, warnings);

	const words = doc.body.split(/\s+/).filter(Boolean).length;
	if (words > options.warnWords) {
		warnings.push({ line: offset, message: `${words} words (warn above ${options.warnWords}); consider splitting the change` });
	}
	if (requirements.length > options.warnRequirements) {
		warnings.push({
			line: offset,
			message: `${requirements.length} requirements (warn above ${options.warnRequirements}); consider splitting the change`,
		});
	}

	return {
		spec: { path, id, linear, owner, capabilities, title, requirements, blocking, words },
		errors: errors.sort(byLine),
		warnings: warnings.sort(byLine),
	};
}

// Added/Modified/Removed only mean something against a maintained capability spec.
// Baselines are opt-in, so a missing one is a warning; a Modified ID absent from an existing one is an error.
function checkBaselines(
	requirements: Requirement[],
	capabilities: string[],
	options: LintOptions,
	errors: Finding[],
	warnings: Finding[],
): void {
	const deltas = requirements.filter((r) => r.delta === "Modified" || r.delta === "Removed");
	if (deltas.length === 0) return;
	const baselineIds = new Set<string>();
	let anyBaseline = false;
	for (const capability of capabilities) {
		const file = join(options.repoRoot, options.capabilitiesDir, `${capability}.md`);
		if (!existsSync(file)) continue;
		const canonical = repositoryFilePath(file, options.repoRoot);
		if (!canonical) {
			errors.push({ line: deltas[0].line, message: `Capability baseline is outside the repository: ${capability}` });
			continue;
		}
		anyBaseline = true;
		for (const line of readFileSync(canonical, "utf8").split("\n")) {
			const match = REQUIREMENT_HEADING.exec(line);
			if (match) baselineIds.add(match[2]);
		}
	}
	if (!anyBaseline) {
		warnings.push({
			line: deltas[0].line,
			message: `Modified/Removed requirements but no capability baseline in ${options.capabilitiesDir}/ for: ${capabilities.join(", ") || "(none listed)"}`,
		});
		return;
	}
	for (const req of deltas) {
		if (!baselineIds.has(req.id)) {
			errors.push({ line: req.line, message: `${req.delta} ${req.id} is not in the capability baseline` });
		}
	}
}

function byLine(a: Finding, b: Finding): number {
	return a.line - b.line;
}

export function formatLint(result: LintResult, displayPath: string): string {
	const lines: string[] = [];
	const { spec, errors, warnings } = result;
	const status = errors.length ? "FAIL" : "ok";
	lines.push(
		`${status}  ${displayPath}  (${spec.requirements.length} requirements, ${spec.words} words, ${spec.blocking.length} blocking questions)`,
	);
	for (const e of errors) lines.push(`  error   L${e.line}: ${e.message}`);
	for (const w of warnings) lines.push(`  warning L${w.line}: ${w.message}`);
	for (const b of spec.blocking) lines.push(`  blocking L${b.line}: ${b.message}`);
	return lines.join("\n");
}
