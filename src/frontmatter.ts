// Minimal YAML frontmatter: `key: value`, `key: [a, b]` and `key:` followed by `  - item` lines.
// Specs keep their headers small, so a full YAML parser is not worth a dependency.

export type FrontmatterValue = string | string[];

export interface ParsedDocument {
	frontmatter: Record<string, FrontmatterValue> | undefined;
	body: string;
	bodyStartLine: number;
	errors: string[];
}

export function parseFrontmatter(text: string): ParsedDocument {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: undefined, body: text, bodyStartLine: 1, errors: [] };
	}
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end === -1) {
		return { frontmatter: undefined, body: text, bodyStartLine: 1, errors: ["Frontmatter has no closing ---"] };
	}

	const frontmatter: Record<string, FrontmatterValue> = {};
	const errors: string[] = [];
	let listKey: string | undefined;
	for (let i = 1; i < end; i++) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item) {
			if (!listKey) {
				errors.push(`Line ${i + 1}: list item without a key`);
				continue;
			}
			(frontmatter[listKey] as string[]).push(unquote(item[1]));
			continue;
		}
		const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (!pair) {
			errors.push(`Line ${i + 1}: expected "key: value"`);
			continue;
		}
		const [, key, raw] = pair;
		if (raw === "") {
			frontmatter[key] = [];
			listKey = key;
		} else if (raw.startsWith("[") && raw.endsWith("]")) {
			frontmatter[key] = raw
				.slice(1, -1)
				.split(",")
				.map((part) => unquote(part.trim()))
				.filter(Boolean);
			listKey = undefined;
		} else {
			frontmatter[key] = unquote(raw.trim());
			listKey = undefined;
		}
	}

	return {
		frontmatter,
		body: lines.slice(end + 1).join("\n"),
		bodyStartLine: end + 2,
		errors,
	};
}

function unquote(value: string): string {
	const match = /^(["'])(.*)\1$/.exec(value);
	return match ? match[2] : value;
}

export function asList(value: FrontmatterValue | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}
