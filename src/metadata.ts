// The minimum durable planning metadata, kept as a visible footer in the Linear issue description.
// Visible text survives Linear's Markdown handling; hidden HTML comments may not.
// Parsing tolerates `*` bullets and a missing rule, in case Linear normalises the Markdown.

export const METADATA_HEADING = "**pi-team**";

export interface IssueMetadata {
	repo?: string;
	spec?: string; // path within the repo, e.g. docs/changes/tenant-identity.md
	specRepo?: string; // profile name of the repo that owns the spec
	specCommit?: string;
	slice?: string;
	source?: string; // where an issue created by /discover came from, e.g. tasks/T012.md
	requirements: string[];
}

export function formatMetadata(meta: IssueMetadata): string {
	const lines = ["---", METADATA_HEADING];
	if (meta.repo) lines.push(`- repo: \`${meta.repo}\``);
	if (meta.spec) {
		const where = meta.specRepo ? `${meta.specRepo}:${meta.spec}` : meta.spec;
		lines.push(`- spec: \`${where}${meta.specCommit ? `@${meta.specCommit.slice(0, 12)}` : ""}\``);
	}
	if (meta.slice) lines.push(`- slice: \`${meta.slice}\``);
	if (meta.source) lines.push(`- source: \`${meta.source}\``);
	if (meta.requirements.length) lines.push(`- requirements: ${meta.requirements.join(", ")}`);
	return lines.join("\n");
}

// The footer is the last line that is exactly the heading, plus the bullet lines directly under it.
function footer(description: string): { start: number; end: number; block: string } | undefined {
	const lines = description.split("\n");
	const at = lines.findLastIndex((line) => line.trim() === METADATA_HEADING);
	if (at === -1) return undefined;
	// Only the footer's own keys belong to it: a bullet a person adds underneath stays part of the acceptance.
	// Blank lines are skipped because a Markdown round-trip may insert one between the heading and its list.
	let end = at + 1;
	for (let i = at + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^[-*]\s+(?:repo|spec|slice|source|requirements):/.test(line)) end = i + 1;
		else if (line) break;
	}
	// The rule above the heading belongs to the footer too, even with blank lines in between.
	let before = at - 1;
	while (before >= 0 && !lines[before].trim()) before--;
	const start = before >= 0 && /^(?:---|\*\*\*|___)$/.test(lines[before].trim()) ? before : at;
	return { start, end, block: lines.slice(at, end).join("\n") };
}

export function parseMetadata(description: string | undefined): IssueMetadata {
	const meta: IssueMetadata = { requirements: [] };
	const found = description ? footer(description) : undefined;
	if (!found) return meta;
	const value = (key: string) => new RegExp(`^[-*]\\s+${key}:\\s+\`?([^\`\\n]+?)\`?\\s*$`, "m").exec(found.block)?.[1];
	meta.repo = value("repo");
	meta.slice = value("slice");
	const source = value("source");
	if (source) meta.source = source;
	const spec = value("spec");
	if (spec) {
		const match = /^(?:([\w.-]+):)?([^@]+)(?:@([0-9a-f]+))?$/.exec(spec);
		if (match) {
			meta.specRepo = match[1];
			meta.spec = match[2];
			meta.specCommit = match[3];
		}
	}
	const reqs = value("requirements");
	if (reqs) meta.requirements = reqs.split(",").map((r) => r.trim()).filter(Boolean);
	return meta;
}

// The issue text a reviewer or implementer should treat as acceptance: everything except the footer,
// including anything a person added after it.
export function stripMetadata(description: string | undefined): string {
	if (!description) return "";
	const found = footer(description);
	if (!found) return description.trim();
	const lines = description.split("\n");
	return [...lines.slice(0, found.start), ...lines.slice(found.end)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
