import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./config.ts";

// Workflow guards are separate from Gondolin's VM boundary. Shell commands can
// still change any writable mounted workspace file, regardless of these path guards.

// Where the sandbox mounts the session directory (see src/sandbox.ts).
const GUEST_WORKSPACE = "/workspace";

export type Mode = "implement" | "spec" | "review";
export const MODES: Mode[] = ["implement", "spec", "review"];

export type GuardDecision =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "confirm"; title: string; message: string; reason: string };

export interface GuardInput {
	mode: Mode;
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	repoRoot: string | undefined;
	generated: string[];
	specDirs: string[];
}

export function guardToolCall(g: GuardInput): GuardDecision {
	if (/linear/i.test(g.toolName) && !g.toolName.startsWith("team_")) {
		return { action: "block", reason: `Linear access in team sessions goes through the team_* tools, not ${g.toolName}` };
	}
	if (g.toolName === "team_checkpoint" && g.mode !== "implement") {
		return { action: "block", reason: `Checkpoints record implementation progress on an issue you started; they are not used in ${g.mode} mode` };
	}

	if (g.toolName === "bash") {
		const command = String(g.input.command ?? "");
		const segments = shellSegments(command);
		if (segments.some(reachesLinear)) {
			return { action: "block", reason: "Linear access in team sessions goes through the team_* tools" };
		}
		const destructive = segments.map(destructiveGit).find(Boolean);
		if (destructive) {
			return {
				action: "confirm",
				title: "Destructive git command",
				message: `${command}\n\nThis can discard work that is not yours. Run it?`,
				reason: `Blocked destructive git command: ${destructive}`,
			};
		}
		return { action: "allow" };
	}

	if (g.toolName !== "write" && g.toolName !== "edit") return { action: "allow" };

	const absolute = canonical(hostPath(String(g.input.path ?? g.input.file_path ?? ""), g.cwd));
	const root = canonical(g.repoRoot ?? g.cwd);
	const rel = relative(root, absolute).split(sep).join("/");
	const insideRepo = !rel.startsWith("..") && !isAbsolute(rel);

	if (insideRepo) {
		// Case-insensitive, because the default macOS filesystem is.
		const generated = g.generated.find((glob) => new RegExp(globToRegExp(glob).source, "i").test(rel));
		if (generated) {
			return { action: "block", reason: `${rel} is generated (${generated}); change the generator and regenerate instead` };
		}
	}

	if (g.mode === "review") {
		return { action: "block", reason: "Review mode is read-only; /work start or /work resume your own issue, or /team mode implement" };
	}
	if (g.mode === "spec") {
		const lower = rel.toLowerCase();
		const allowed = insideRepo && g.specDirs.some((dir) => lower.startsWith(`${dir.replace(/\/$/, "").toLowerCase()}/`));
		if (!allowed) {
			return {
				action: "block",
				reason: `Spec mode only edits ${g.specDirs.join(", ")}; switch with /team mode implement after /work start`,
			};
		}
	}
	return { action: "allow" };
}

// Resolve a tool path the way the host's write and edit tools do, so the guard judges the file that is written.
function hostPath(raw: string, cwd: string): string {
	let path = raw.replace(/[  -   　]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) {
		try {
			path = fileURLToPath(path);
		} catch {
			// leave as typed; it will not resolve inside the repository
		}
	}
	// Tools run in the sandbox, where the session directory is mounted at /workspace. A guest path, however
	// it was spelled (plain, @-prefixed or file://), names the file under the session directory on the host.
	const guest = isAbsolute(path) ? resolve(path) : undefined;
	if (guest === GUEST_WORKSPACE || guest?.startsWith(`${GUEST_WORKSPACE}/`)) return join(cwd, guest.slice(GUEST_WORKSPACE.length));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

// Resolve symlinks (e.g. macOS /var -> /private/var) through the nearest existing ancestor,
// so a path compares correctly with the root git reports.
function canonical(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing) && dirname(existing) !== existing) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	try {
		// The native call also returns the on-disk spelling, so /USERS/x and /Users/x compare equal on macOS.
		return join(realpathSync.native(existing), ...rest);
	} catch {
		return path;
	}
}

// Split a shell command into simple commands and their words. Quotes are honoured, so text inside a
// quoted argument (a commit message, a grep pattern) is not mistaken for a command; comments and here-doc
// bodies are dropped; command substitutions are analysed as commands of their own.
export function shellSegments(command: string): string[][] {
	const text = stripHereDocs(command.replace(/\\\r?\n/g, ""));
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let hasWord = false;
	let quote: '"' | "'" | undefined;
	// Quote state to restore when a $(...) or `...` substitution opened inside double quotes closes.
	const substitutions: Array<'"' | undefined> = [];
	let backtick: { resume: '"' | undefined } | undefined;
	const endWord = () => {
		if (hasWord) words.push(word);
		word = "";
		hasWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length) segments.push(words);
		words = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
			continue;
		}
		// Substitutions run commands even inside double quotes.
		if (c === "$" && text[i + 1] === "(") {
			endSegment();
			substitutions.push(quote);
			quote = undefined;
			i++;
			continue;
		}
		if (c === "`") {
			endSegment();
			if (backtick) {
				quote = backtick.resume;
				backtick = undefined;
			} else {
				backtick = { resume: quote };
				quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && i + 1 < text.length) word += text[++i];
			else word += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			hasWord = true;
		} else if (c === "\\" && i + 1 < text.length) {
			word += text[++i];
			hasWord = true;
		} else if (c === "#" && !hasWord) {
			// A comment runs to the end of the line; an apostrophe inside it must not open a quote.
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else if (c === " " || c === "\t") endWord();
		else if (c === ">" || c === "<") endWord();
		else if (c === ")") {
			endSegment();
			if (substitutions.length) quote = substitutions.pop();
		} else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(") endSegment();
		else {
			word += c;
			hasWord = true;
		}
	}
	endSegment();
	return segments;
}

// Remove here-document bodies: they are data for the command, not commands.
function stripHereDocs(text: string): string {
	const out: string[] = [];
	let delimiter: string | undefined;
	for (const line of text.split("\n")) {
		if (delimiter !== undefined) {
			if (line.trim() === delimiter) delimiter = undefined;
			continue;
		}
		out.push(line);
		delimiter = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)?.[2];
	}
	return out.join("\n");
}

const KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);
// Programs that run another command given as their arguments.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "timeout", "xargs", "stdbuf", "caffeinate"]);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

// A simple command's words after shell keywords and leading `VAR=value` assignments.
function commandWords(words: string[]): string[] {
	let i = 0;
	while (i < words.length && (isAssignment(words[i]) || KEYWORDS.has(words[i]))) i++;
	return words.slice(i);
}

// Programs that can make an HTTP request; reading or mentioning the URL with anything else is harmless.
const NETWORK_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh", "nc", "ncat", "node", "bun", "deno", "python", "python3", "ruby", "perl", "php"]);

function reachesLinear(words: string[]): boolean {
	if (!words.some((w) => /api\.linear\.app/i.test(w))) return false;
	const rest = commandWords(words);
	// `URL=https://api.linear.app/graphql` on its own line is preparation for a call.
	if (!rest.length) return true;
	const programs = WRAPPERS.has(basename(rest[0])) ? rest : [rest[0]];
	return programs.some((w) => NETWORK_PROGRAMS.has(basename(w)));
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

// The git invocation in a simple command, looking through wrappers such as `xargs git …` or `timeout 30 git …`.
function gitInvocation(words: string[]): string[] | undefined {
	const rest = commandWords(words);
	if (!rest.length) return undefined;
	if (basename(rest[0]) === "git") return rest.slice(1);
	if (!WRAPPERS.has(basename(rest[0]))) return undefined;
	const at = rest.findIndex((w, i) => i > 0 && basename(w) === "git");
	return at === -1 ? undefined : rest.slice(at + 1);
}

// Returns a short description when a simple command is a git invocation that can discard work.
export function destructiveGit(words: string[]): string | undefined {
	const rest = gitInvocation(words);
	if (!rest) return undefined;
	let i = 0;
	while (i < rest.length && rest[i].startsWith("-")) i += GIT_OPTIONS_WITH_VALUE.has(rest[i]) ? 2 : 1;
	const sub = rest[i];
	const args = rest.slice(i + 1);
	const has = (...flags: string[]) => args.some((a) => flags.includes(a));
	// A short-option cluster containing the letter, e.g. -fd or -xfd.
	const short = (letter: string) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
	const hit = (what: string) => `git ${sub} ${what}`.trim();

	switch (sub) {
		case "reset":
			return has("--hard") ? hit("--hard") : undefined;
		case "clean":
			if (has("--dry-run") || short("n")) return undefined;
			return has("--force") || short("f") ? hit("--force") : undefined;
		case "checkout": {
			if (has("--force") || short("f")) return hit("--force");
			if (short("B")) return hit("-B");
			const separator = args.indexOf("--");
			if (separator !== -1) return separator < args.length - 1 ? hit("-- <paths>") : undefined;
			// Creating or detaching takes a start point, not paths.
			if (short("b") || has("--orphan", "--track", "--detach") || short("t") || short("d")) return undefined;
			const operands = args.filter((a) => !a.startsWith("-"));
			// `checkout <tree-ish> <path>` and `checkout <dir>/` overwrite working-tree files.
			if (operands.length >= 2) return hit("<tree-ish> <paths>");
			return operands.some((a) => a === "." || a.endsWith("/") || a.startsWith("./") || a.startsWith("../")) ? hit("<paths>") : undefined;
		}
		case "switch":
			if (has("--force", "--discard-changes") || short("f")) return hit("--force");
			return short("C") || has("--force-create") ? hit("--force-create") : undefined;
		case "restore":
			return (has("--staged") || short("S")) && !has("--worktree") && !short("W") ? undefined : hit("");
		case "stash":
			return args[0] === "drop" || args[0] === "clear" ? hit(args[0]) : undefined;
		case "push":
			if (has("--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune") || short("f") || short("d")) return hit("--force/--delete");
			if (args.some((a) => /^--force-with-lease=/.test(a))) return hit("--force-with-lease");
			// A refspec starting with + forces; one starting with : deletes.
			return args.some((a) => !a.startsWith("-") && /^[+:]/.test(a)) ? hit("+refspec/:refspec") : undefined;
		case "branch":
			// -D deletes unmerged work; -f and -M move a branch off its commits.
			return short("D") || short("M") || has("--force") || short("f") ? hit("--force") : undefined;
		case "worktree":
			return args[0] === "remove" && (has("--force") || short("f")) ? hit("remove --force") : undefined;
		default:
			return undefined;
	}
}
