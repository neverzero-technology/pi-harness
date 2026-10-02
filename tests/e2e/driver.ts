import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeLinear } from "../fake-linear.ts";
import { git, profiledRepo, tempDir, write } from "../helpers.ts";

const launcher = fileURLToPath(new URL("../../bin/pi-team.mjs", import.meta.url));

export interface Dialog {
	method: "confirm" | "select" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
}
export type Answer = (dialog: Dialog) => boolean | string | undefined;

export interface RunResult {
	messages: string[]; // custom messages the extension displayed
	prompts: string[]; // user messages the extension sent to the model
	notices: string[];
	dialogs: Dialog[];
	status: Record<string, string | undefined>;
	modelTurns: number;
	assistant: string[]; // assistant text, when a real model is attached
	tools: { name: string; args: any; isError: boolean; text: string }[];
}

// Drives a real Pi process in RPC mode: sends slash commands and answers extension dialogs.
export class PiSession {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = "";
	private seq = 0;
	private listener: ((record: any) => void) | undefined;
	readonly status: Record<string, string | undefined> = {};
	stderr = "";

	constructor(cwd: string, env: NodeJS.ProcessEnv, realModel = false) {
		// By default a deliberately invalid key: if a command hands a prompt to the model, the request
		// fails immediately instead of spending anyone's quota. `realModel` uses the team model.
		const model = realModel ? [] : ["--offline", "--model", "openai/gpt-4o-mini", "--api-key", "e2e-invalid"];
		this.proc = spawn(process.execPath, [launcher, "--mode", "rpc", "--no-session", ...model], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let record: any;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				if (record.type === "extension_ui_request" && record.method === "setStatus") this.status[record.statusKey] = record.statusText;
				this.listener?.(record);
			}
		});
		this.proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
	}

	private send(record: unknown): void {
		this.proc.stdin.write(`${JSON.stringify(record)}\n`);
	}

	// With `untilSettled`, waits for the model to finish the work the command started.
	run(message: string, answer: Answer = () => true, timeoutMs = 60_000, untilSettled = false): Promise<RunResult> {
		return this.runUntil(message, () => true, answer, timeoutMs, untilSettled);
	}

	// For a command that hands a prompt to the model: the prompt event can trail the command's response.
	prompt(message: string, answer: Answer = () => true): Promise<RunResult> {
		return this.runUntil(message, (result) => result.prompts.length > 0, answer, 60_000, false);
	}

	private runUntil(message: string, done: (result: RunResult) => boolean, answer: Answer, timeoutMs: number, untilSettled: boolean): Promise<RunResult> {
		const id = `req-${++this.seq}`;
		const result: RunResult = { messages: [], prompts: [], notices: [], dialogs: [], status: this.status, modelTurns: 0, assistant: [], tools: [] };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listener = undefined;
				reject(new Error(`Timed out running ${message}\n${JSON.stringify(result, null, 1)}\n${this.stderr}`));
			}, timeoutMs);
			let handled = false;
			let settle: NodeJS.Timeout | undefined;
			const finish = () => {
				clearTimeout(timer);
				this.listener = undefined;
				resolve(result);
			};
			this.listener = (record) => {
				if (record.type === "extension_ui_request") {
					if (record.method === "notify") result.notices.push(record.message);
					if (["confirm", "select", "input", "editor"].includes(record.method)) {
						const dialog: Dialog = { method: record.method, title: record.title, message: record.message, options: record.options };
						result.dialogs.push(dialog);
						const value = answer(dialog);
						if (value === undefined) this.send({ type: "extension_ui_response", id: record.id, cancelled: true });
						else if (typeof value === "boolean") this.send({ type: "extension_ui_response", id: record.id, confirmed: value });
						else this.send({ type: "extension_ui_response", id: record.id, value });
					}
				} else if (record.type === "message_end" && record.message?.role === "custom") {
					result.messages.push(String(record.message.content));
				} else if (record.type === "message_end" && record.message?.role === "user") {
					const content = record.message.content;
					result.prompts.push(typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("\n"));
				} else if (record.type === "message_end" && record.message?.role === "assistant") {
					const text = (record.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					if (text.trim()) result.assistant.push(text);
				} else if (record.type === "tool_execution_start") {
					result.tools.push({ name: record.toolName, args: record.args, isError: false, text: "" });
				} else if (record.type === "tool_execution_end") {
					const call = result.tools.findLast((t) => t.name === record.toolName && !t.text);
					if (call) {
						call.isError = Boolean(record.isError);
						call.text = (record.result?.content ?? []).map((c: any) => c.text ?? "").join("\n") || "(empty)";
					}
				} else if (record.type === "agent_start") {
					result.modelTurns++;
				} else if (record.type === "agent_settled") {
					if (untilSettled && handled) {
						finish();
						return;
					}
				} else if (record.type === "response" && record.id === id) {
					if (!record.success) {
						clearTimeout(timer);
						this.listener = undefined;
						reject(new Error(`Command failed: ${JSON.stringify(record)}`));
						return;
					}
					handled = true;
				}
				// Messages can trail the response by a tick; settle once the stream goes quiet.
				// With `untilSettled`, a command that starts no model turn within a few seconds is complete too.
				if (handled && done(result) && !(untilSettled && result.modelTurns > 0)) {
					clearTimeout(settle);
					settle = setTimeout(finish, untilSettled ? 3000 : 400);
				} else {
					clearTimeout(settle);
				}
			};
			this.send({ id, type: "prompt", message });
		});
	}

	async close(): Promise<void> {
		if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
		const closed = new Promise((resolve) => this.proc.once("close", resolve));
		this.proc.stdin.end();
		this.proc.kill("SIGTERM");
		await closed;
	}

	bash(command: string, timeoutMs = 60_000): Promise<any> {
		const id = `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.listener = undefined; reject(new Error(`Shell command timed out: ${this.stderr}`)); }, timeoutMs);
			this.listener = (record) => {
				if (record.type !== "response" || record.id !== id) return;
				clearTimeout(timer);
				this.listener = undefined;
				if (record.success) resolve(record.data);
				else reject(new Error(record.error));
			};
			this.send({ id, type: "bash", command });
		});
	}
}

export interface Fixture {
	root: string;
	linear: FakeLinear;
	ghDir: string;
	session(cwd?: string, realModel?: boolean): PiSession;
	setPr(pr: Record<string, unknown> | undefined): void;
	closeSessions(): Promise<void>;
	close(): Promise<void>;
}

// A repository that has adopted the workflow (its profile is merged on a local origin), a fake `gh`,
// and a fake Linear over HTTP.
export async function fixture(): Promise<Fixture> {
	const { root } = profiledRepo();
	write(root, "release.lock.yaml", "release:\n  version: 0.1.0-alpha.1\n  tag: v0.1.0-alpha.1\n  commit: 3517dd4818a7\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "release pin");
	git(root, "push", "-q", "origin", "main");

	const ghDir = tempDir("pi-team-e2e-gh-");
	mkdirSync(join(ghDir, "bin"));
	writeFileSync(
		join(ghDir, "bin", "gh"),
		`#!/bin/sh\ncase "$1 $2" in\n"auth status") exit 0 ;;\n"pr list") cat "${ghDir}/pr-list.json" 2>/dev/null || echo "[]" ;;\n"pr view") cat "${ghDir}/pr-view.json" ;;\n"pr create") echo "$@" > "${ghDir}/pr-create.args"; echo "https://github.example/pr/1" ;;\n*) echo "fake gh: $*" >&2; exit 1 ;;\nesac\n`,
	);
	chmodSync(join(ghDir, "bin", "gh"), 0o755);

	const linear = new FakeLinear();
	const server = await linear.listen();
	const sessions: PiSession[] = [];
	const env = {
		...process.env,
		PATH: `${join(ghDir, "bin")}:${process.env.PATH}`,
		LINEAR_API_KEY: "test-key",
		PI_TEAM_LINEAR_URL: server.url,
	};
	const closeSessions = async () => { await Promise.all(sessions.splice(0).map((s) => s.close())); };
	return {
		root,
		linear,
		ghDir,
		session(cwd = root, realModel = false) {
			const session = new PiSession(cwd, { ...env, PI_TEAM_REVIEWER_BIN: process.env.PI_TEAM_REVIEWER_BIN }, realModel);
			sessions.push(session);
			return session;
		},
		setPr(pr) {
			writeFileSync(join(ghDir, "pr-list.json"), JSON.stringify(pr ? [pr] : []));
			if (pr) writeFileSync(join(ghDir, "pr-view.json"), JSON.stringify(pr));
		},
		async close() {
			await closeSessions();
			await server.close();
		},
		closeSessions,
	};
}
