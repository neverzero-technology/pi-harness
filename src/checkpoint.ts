import { randomBytes } from "node:crypto";

// A checkpoint is a Linear comment holding only what another engineer needs to resume.
// The `cp-xxxxxxxx` id lets a retry find out whether an uncertain post was actually stored.
// Parsing tolerates Markdown normalisation (`*` bullets, heading level) on the way back from Linear.

export const CHECKPOINT_HEADING = "### pi-team checkpoint";
const DIRTY_NOTE = "tree had uncommitted changes";

export type CheckpointKind = "start" | "progress" | "blocked" | "handoff" | "final";

export interface CheckResult {
	command: string;
	result: "pass" | "fail" | "skipped" | "unavailable";
	scope: "local" | "simulated" | "live" | "ci";
	commit?: string;
	note?: string;
	dirty?: boolean;
}

export interface Checkpoint {
	id: string;
	kind: CheckpointKind;
	issue: string;
	owner: string;
	spec: string;
	branch?: string;
	commit?: string;
	pr?: string;
	done: string[];
	remaining: string[];
	checks: CheckResult[];
	blocker?: string;
	next: string;
	unsynced: string[];
}

export function newCheckpointId(): string {
	return `cp-${randomBytes(4).toString("hex")}`;
}

const SECRET_PATTERNS: RegExp[] = [
	/\blin_(?:api|oauth)_[A-Za-z0-9]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	// An API key has mixed case and digits; a lowercase slug such as "sk-learn-pipeline-tests" is not one.
	/\bsk-(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b((?:Bearer|Basic)\s+)[A-Za-z0-9+/._=-]{20,}/g,
	// NAME=value or name: value where the name mentions a credential, including PREFIX_TOKEN and client_secret forms.
	// The value must look generated (12+ characters with a digit), so prose such as "token: refresh logic" is left alone.
	/((?<![A-Za-z0-9])[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_-]*\s*[=:]\s*["']?)(?=[^\s"'`]*\d)[^\s"'`]{12,}/gi,
];

// Anything headed for Linear passes through this. It is a backstop, not permission to paste secrets.
export function redactSecrets(text: string): string {
	return SECRET_PATTERNS.reduce(
		(out, pattern) => out.replace(pattern, (_match, prefix) => `${typeof prefix === "string" ? prefix : ""}[redacted]`),
		text,
	);
}

// Every field is one line, so a multi-line value cannot break the format or hide a later line.
const oneLine = (text: string) => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();

export function formatCheckpoint(cp: Checkpoint): string {
	// An empty item would end the list when parsed back, hiding the items after it.
	const list = (items: string[]) => {
		const lines = items.map(oneLine).filter(Boolean);
		return lines.length ? lines.map((i) => `- ${i}`).join("\n") : "- none";
	};
	const checks = cp.checks.length
		? cp.checks
				.map((c) => {
					const at = c.commit ? ` @ \`${c.commit.slice(0, 12)}\`` : "";
					const notes = [c.dirty ? DIRTY_NOTE : undefined, c.note ? oneLine(c.note) : undefined].filter(Boolean).join("; ");
					return `- \`${oneLine(c.command).replace(/`/g, "'")}\` — **${c.result}** (${c.scope})${at}${notes ? ` — ${notes}` : ""}`;
				})
				.join("\n")
		: "- none recorded";
	return redactSecrets(
		[
			`${CHECKPOINT_HEADING} \`${cp.id}\` (${cp.kind})`,
			"",
			`**Issue:** ${cp.issue} · **Owner:** ${cp.owner}`,
			`**Spec:** ${cp.spec}`,
			`**Branch:** ${cp.branch ? `\`${cp.branch}\`` : "none"} · **Commit:** ${cp.commit ? `\`${cp.commit.slice(0, 12)}\`` : "none"} · **PR:** ${cp.pr ?? "none"}`,
			"",
			"**Done**",
			list(cp.done),
			"",
			"**Remaining**",
			list(cp.remaining),
			"",
			"**Checks**",
			checks,
			"",
			`**Blocker:** ${cp.blocker ? oneLine(cp.blocker) : "none"}`,
			`**Next:** ${oneLine(cp.next)}`,
			`**Unsynced local state:** ${cp.unsynced.length ? cp.unsynced.join("; ") : "none"}`,
		].join("\n"),
	);
}

export interface CommentLike {
	id: string;
	body: string;
	createdAt: string;
	author?: string;
}

export interface ParsedCheckpoint {
	id: string;
	kind: string;
	createdAt: string;
	author?: string;
	commit?: string;
	branch?: string;
	next?: string;
	blocker?: string;
	done: string[];
	// undefined when the comment has no Remaining section at all, which is not the same as "nothing remaining".
	remaining: string[] | undefined;
	checks: CheckResult[];
	body: string;
}

const HEADING = /^#{1,6}\s*pi-team checkpoint\s+`?(cp-[0-9a-f]+)`?\s+\((\w+)\)/m;
// A command never contains a backtick (formatCheckpoint replaces them), so the first pair delimits it.
const CHECK_ITEM =
	/^`([^`]+)`\s+—\s+\*\*(pass|fail|skipped|unavailable)\*\*\s+\((local|simulated|live|ci)\)(?:\s+@\s+`([0-9a-f]+)`)?(?:\s+—\s+(.*))?$/;

// Parsing follows the structure, not the text: list items are read only inside their own section and
// single-value fields only from lines that start with their label. An item such as
// "- `make verify` — **pass** (local)" under Done is therefore just a Done item, never a check.
function section(lines: string[], name: string): string[] | undefined {
	const start = lines.findIndex((l) => l === `**${name}**`);
	if (start === -1) return undefined;
	const items: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const item = /^[-*]\s+(.*)$/.exec(line);
		if (item) items.push(item[1].trim());
		else if (line) break;
	}
	return items.filter((i) => i !== "none");
}

function checkItems(items: string[]): CheckResult[] {
	return items
		.map((item) => CHECK_ITEM.exec(item))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({
			command: m[1],
			result: m[2] as CheckResult["result"],
			scope: m[3] as CheckResult["scope"],
			commit: m[4],
			note: m[5],
			dirty: m[5]?.includes(DIRTY_NOTE) || undefined,
		}));
}

const bodyLines = (body: string) => body.split(/\r?\n/).map((l) => l.trim());

export function parseChecks(body: string): CheckResult[] {
	return checkItems(section(bodyLines(body), "Checks") ?? []);
}

export function parseCheckpoint(comment: CommentLike): ParsedCheckpoint | undefined {
	const heading = HEADING.exec(comment.body);
	if (!heading) return undefined;
	const lines = bodyLines(comment.body);
	// Blocker and Next own a line each; the last such line wins because they follow the lists.
	const ownLine = (label: string) => lines.findLast((l) => l.startsWith(`**${label}:**`))?.slice(label.length + 5).trim();
	// Branch, Commit and PR share one line, separated by "·".
	const shared = (label: string) => {
		const line = lines.find((l) => l.startsWith("**Branch:**")) ?? "";
		const part = line.split(" · ").find((p) => p.startsWith(`**${label}:**`));
		const value = part?.slice(label.length + 5).trim().replace(/`/g, "");
		return value && value !== "none" ? value : undefined;
	};
	const blocker = ownLine("Blocker");
	return {
		id: heading[1],
		kind: heading[2],
		createdAt: comment.createdAt,
		author: comment.author,
		commit: shared("Commit"),
		branch: shared("Branch"),
		next: ownLine("Next") || undefined,
		blocker: blocker && blocker !== "none" ? blocker : undefined,
		done: section(lines, "Done") ?? [],
		remaining: section(lines, "Remaining"),
		checks: checkItems(section(lines, "Checks") ?? []),
		body: comment.body,
	};
}

export function checkpoints(comments: CommentLike[]): ParsedCheckpoint[] {
	return comments
		.map(parseCheckpoint)
		.filter((cp): cp is ParsedCheckpoint => cp !== undefined)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function latestCheckpoint(comments: CommentLike[]): ParsedCheckpoint | undefined {
	return checkpoints(comments).at(-1);
}

// The most recent recorded result of each command, across every checkpoint on the issue.
export function latestChecks(comments: CommentLike[]): CheckResult[] {
	const byCommand = new Map<string, CheckResult>();
	for (const cp of checkpoints(comments)) {
		for (const check of cp.checks) {
			byCommand.delete(check.command);
			byCommand.set(check.command, check);
		}
	}
	return [...byCommand.values()];
}

export function containsCheckpoint(comments: CommentLike[], id: string): boolean {
	return comments.some((c) => c.body.includes(id));
}
