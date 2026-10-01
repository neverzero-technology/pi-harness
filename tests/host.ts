import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { registerTeam } from "../extensions/team.ts";
import { FakeLinear } from "./fake-linear.ts";
import { realExec, tempDir } from "./helpers.ts";

// An in-process stand-in for the Pi host: it records what the extension registers and lets tests drive
// commands, tools and events directly, with a fake VM in place of the sandbox.

type Handler = (...args: any[]) => any;

export function host(cwd: string) {
	const commands = new Map<string, { handler: Handler }>();
	const tools = new Map<string, any>();
	const events = new Map<string, Handler[]>();
	const entries: any[] = [];
	const messages: any[] = [];
	const userMessages: string[] = [];
	const notices: string[] = [];
	const status = new Map<string, string | undefined>();
	const thinking: string[] = [];
	const confirms: { title: string; message: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const answers = { confirm: true, select: (options: string[]): string | undefined => options.at(-1) };
	const pi: any = {
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (event: string, handler: Handler) => events.set(event, [...(events.get(event) ?? []), handler]),
		exec: (command: string, args: string[], options: any) => realExec(command, args, options),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any) => messages.push(message),
		sendUserMessage: (text: string) => userMessages.push(text),
		getAllTools: () => [...tools.values()].map((t) => ({ name: t.name, sourceInfo: { path: "x" } })),
		getCommands: () => [],
		getThinkingLevel: () => thinking.at(-1) ?? "medium",
		setThinkingLevel: (level: string) => thinking.push(level),
	};
	const ctx: any = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return answers.confirm;
			},
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return answers.select(options);
			},
		},
	};
	const emit = async (event: string, payload: unknown): Promise<any> => {
		let result: any;
		for (const handler of events.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};
	registerTeam(pi, { cwd, createVm: async () => ({ exec: async () => ({ exitCode: 0, stdout: "/bin/bash\n" }), close: async () => {} }) as unknown as VM });
	return { pi, ctx, commands, tools, entries, messages, userMessages, notices, status, thinking, confirms, selects, answers, emit };
}


// Runs `body` with the Linear client pointed at an in-process fake.
export async function withLinear(body: (linear: FakeLinear) => Promise<void>): Promise<void> {
	const linear = new FakeLinear();
	const realFetch = globalThis.fetch;
	const savedKey = process.env.LINEAR_API_KEY;
	process.env.LINEAR_API_KEY = "test-key";
	globalThis.fetch = linear.fetch as unknown as typeof fetch;
	try {
		await body(linear);
	} finally {
		globalThis.fetch = realFetch;
		if (savedKey === undefined) delete process.env.LINEAR_API_KEY;
		else process.env.LINEAR_API_KEY = savedKey;
	}
}

// Puts a fake `gh` first on PATH for the duration of `body`. It answers `pr list` and `pr view` from the
// pull request handed to `setPr`, and fails every call after `fail()`.
export interface FakeGh {
	setPr(pr: Record<string, unknown> | undefined): void;
	fail(message?: string): void;
	// The arguments of the last `gh pr create`, one per element, or undefined if it was never called.
	created(): string[] | undefined;
}

export async function withGh(body: (gh: FakeGh) => Promise<void>): Promise<void> {
	const dir = tempDir("pi-team-gh-");
	mkdirSync(join(dir, "bin"));
	const script = join(dir, "bin", "gh");
	const working = [
		"#!/bin/sh",
		'case "$1 $2" in',
		'"auth status") exit 0 ;;',
		`"pr list") cat "${dir}/pr-list.json" 2>/dev/null || echo "[]" ;;`,
		`"pr view") cat "${dir}/pr-view.json" ;;`,
		`"pr create") for a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/pr-create.args"; echo "https://github.example/pr/99" ;;`,
		"*) exit 1 ;;",
		"esac",
		"",
	].join("\n");
	writeFileSync(script, working);
	chmodSync(script, 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${join(dir, "bin")}:${savedPath}`;
	try {
		await body({
			setPr(pr) {
				writeFileSync(script, working);
				writeFileSync(join(dir, "pr-list.json"), JSON.stringify(pr ? [pr] : []));
				if (pr) writeFileSync(join(dir, "pr-view.json"), JSON.stringify(pr));
			},
			fail(message = "gh: could not connect") {
				writeFileSync(script, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
			},
			created() {
				const file = join(dir, "pr-create.args");
				return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : undefined;
			},
		});
	} finally {
		process.env.PATH = savedPath;
	}
}
