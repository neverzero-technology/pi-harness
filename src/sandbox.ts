// Tool adapters adapted from Pi 0.99.2's Gondolin example (MIT).
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts
// Harness policy: mandatory VM execution, explicit environment, read-only reviewer mounts.
import path from "node:path";
import type { VM, VMOptions } from "@earendil-works/gondolin";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT } from "./config.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

export const SANDBOX_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export interface SandboxOptions {
	readOnly?: boolean;
	/** Internal dependency injection for unit tests; the launcher offers no sandbox opt-out. */
	createVm?: (options: VMOptions) => Promise<VM>;
	cwd?: string;
}

export interface SandboxHandle {
	ready(): boolean;
	hostPath(input: string): string;
}

export function registerSandbox(pi: ExtensionAPI, options: SandboxOptions = {}): SandboxHandle {
	const requestedCwd = path.resolve(options.cwd ?? process.cwd());
	const localCwd = realpathSync(requestedCwd);
	let vm: VM | undefined;
	let starting: Promise<VM> | undefined;
	let failure: Error | undefined;
	let shellPath = "/bin/sh";
	let stopping = false;
	let closing: Promise<void> | undefined;
	const allowed = new Set(options.readOnly ? READ_ONLY_TOOLS : [...SANDBOX_TOOLS, "codemode", "tool_search"]);

	async function startVm(): Promise<VM> {
		const { VM, RealFSProvider, ReadonlyProvider } = await import("@earendil-works/gondolin");
		const workspace = new RealFSProvider(localCwd);
		const provider = options.readOnly ? new ReadonlyProvider(workspace) : workspace;
		const mounts = { [GUEST_WORKSPACE]: provider, [localCwd]: provider, [requestedCwd]: provider };
		// Linked worktrees refer to shared metadata by its absolute host path. Expose only
		// that Git directory, never the main checkout or the worktrees' parent directory.
		try {
			const commonPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: requestedCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			const common = realpathSync(commonPath);
			if (!isInsideHostPath(localCwd, common)) {
				const git = new RealFSProvider(common);
				mounts[common] = options.readOnly ? new ReadonlyProvider(git) : git;
				mounts[commonPath] = mounts[common];
			}
		} catch { /* A non-Git workspace needs no additional mount. */ }
		for (const dir of ["skills", "templates", "review"]) {
			const resource = path.resolve(PACKAGE_ROOT, dir);
			mounts[resource] = new ReadonlyProvider(new RealFSProvider(resource));
		}
		const created = await (options.createVm ?? VM.create)({
			sessionLabel: `pi-team ${options.readOnly ? "review " : ""}${path.basename(localCwd)}`,
			sandbox: { vmm: "qemu" },
			env: { TERM: "xterm-256color" },
			vfs: { mounts },
		});
		try {
			if (!options.readOnly) {
				// Gondolin's stock Alpine image is intentionally minimal. Install the
				// baseline coding tools in the disposable guest, never on the host.
				const setup = await created.exec(["/bin/sh", "-lc", "if command -v bash >/dev/null && command -v git >/dev/null && command -v node >/dev/null && command -v npm >/dev/null; then exit 0; fi; apk add --no-cache bash git nodejs npm"], { cwd: "/" });
				if (setup.exitCode !== 0) throw new Error(`Guest toolchain setup failed: ${setup.stderr}`);
				const gitSetup = await created.exec(["/bin/sh", "-lc", 'for dir do git config --global --add safe.directory "$dir"; done', "pi-team", GUEST_WORKSPACE, localCwd, requestedCwd]);
				if (gitSetup.exitCode !== 0) throw new Error(`Guest Git setup failed: ${gitSetup.stderr}`);
				// Commits are made in the guest, where the host's global Git identity is not visible.
				const hostConfig = (key: string) => {
					try {
						return execFileSync("git", ["config", "--get", key], { cwd: requestedCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
					} catch {
						return "";
					}
				};
				const [userName, userEmail] = [hostConfig("user.name"), hostConfig("user.email")];
				if (userName && userEmail) {
					const identity = await created.exec(["/bin/sh", "-lc", 'git config --global user.name "$1" && git config --global user.email "$2"', "pi-team", userName, userEmail]);
					if (identity.exitCode !== 0) throw new Error(`Guest Git identity setup failed: ${identity.stderr}`);
				}
			}
			const probe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
			shellPath = probe.stdout.trim() || "/bin/sh";
			if (stopping) throw new Error("Sandbox session is shutting down");
			vm = created;
			return created;
		} catch (error) {
			await created.close();
			throw error;
		}
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		await closing;
		if (stopping) throw new Error("Sandbox session is shutting down");
		if (failure) throw failure;
		if (ctx && realpathSync(ctx.cwd) !== localCwd) throw new Error("Workspace changed; start pi-team in the new workspace");
		if (vm) return vm;
		if (!starting) {
			starting = startVm().catch((error: unknown) => {
				failure = new Error(`Gondolin sandbox unavailable: ${error instanceof Error ? error.message : String(error)}. Install QEMU and Node >=24; see README. Host execution is blocked.`);
				throw failure;
			}).finally(() => { starting = undefined; });
		}
		return starting;
	}

	function cancelVm(active: VM): Promise<void> {
		if (closing) return closing;
		if (vm === active) vm = undefined;
		// Gondolin 0.12 aborts the host wait but leaves the guest process running.
		// Closing the whole VM stops all descendants; the next call boots a fresh VM.
		closing = active.close().catch((error: unknown) => {
			failure = new Error(`Could not stop the cancelled sandbox: ${String(error)}. Restart pi-team.`);
			throw failure;
		}).finally(() => { closing = undefined; });
		return closing;
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureVm(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("pi-team-sandbox", `Gondolin · ${options.readOnly ? "read-only" : "workspace"}`);
	});
	pi.on("session_shutdown", async () => {
		stopping = true;
		try { await starting; } catch { /* Startup failure is already reported. */ }
		await closing;
		const active = vm;
		vm = undefined;
		await active?.close();
	});
	pi.on("tool_call", async (event, ctx) => {
		// The harness's own team_* tools run on the host by design; the reviewer gets none of them.
		const teamTool = !options.readOnly && event.toolName.startsWith("team_");
		if (!allowed.has(event.toolName) && !teamTool) return { block: true, reason: `${event.toolName} is outside the harness sandbox tool policy` };
		await ensureVm(ctx);
	});
	pi.on("user_bash", async (_event, ctx) => {
		if (options.readOnly) throw new Error("Reviewer shell commands are disabled");
		return { operations: createGondolinBashOps(await ensureVm(ctx), localCwd, shellPath, cancelVm) };
	});
	pi.on("before_agent_start", async (event, ctx) => {
		await ensureVm(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\nRepository tools execute in a Gondolin Linux VM. The workspace is ${GUEST_WORKSPACE}, shared with ${localCwd}. Absolute host workspace paths also work. Other host files and credentials are unavailable. Harness resources are mounted read-only at their original paths.` };
	});

	const read = createReadTool(localCwd);
	pi.registerTool({ ...read, async execute(id, params, signal, onUpdate, ctx) {
		const active = await ensureVm(ctx);
		return createReadTool(localCwd, { operations: createGondolinReadOps(active, localCwd) }).execute(id, params, signal, onUpdate);
	} });
	const ls = createLsTool(localCwd);
	pi.registerTool({ ...ls, async execute(id, params, signal, onUpdate, ctx) {
		return createLsTool(localCwd, { operations: createGondolinLsOps(await ensureVm(ctx), localCwd) }).execute(id, params, signal, onUpdate);
	} });
	const find = createFindTool(localCwd);
	pi.registerTool({ ...find, async execute(id, params, signal, onUpdate, ctx) {
		return createFindTool(localCwd, { operations: createGondolinFindOps(await ensureVm(ctx), localCwd) }).execute(id, params, signal, onUpdate);
	} });
	const grep = createGrepTool(localCwd);
	pi.registerTool({ ...grep, async execute(_id, params, signal, _onUpdate, ctx) {
		return executeGondolinGrep(await ensureVm(ctx), localCwd, params, signal);
	} });
	if (!options.readOnly) {
		const write = createWriteTool(localCwd);
		pi.registerTool({ ...write, async execute(id, params, signal, onUpdate, ctx) {
			return createWriteTool(localCwd, { operations: createGondolinWriteOps(await ensureVm(ctx), localCwd) }).execute(id, params, signal, onUpdate);
		} });
		const edit = createEditTool(localCwd);
		pi.registerTool({ ...edit, async execute(id, params, signal, onUpdate, ctx) {
			return createEditTool(localCwd, { operations: createGondolinEditOps(await ensureVm(ctx), localCwd) }).execute(id, params, signal, onUpdate);
		} });
		const bash = createBashTool(localCwd);
		pi.registerTool({ ...bash, async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureVm(ctx);
			return createBashTool(localCwd, { operations: createGondolinBashOps(active, localCwd, shellPath, cancelVm) }).execute(id, params, signal, onUpdate);
		} });
	}
	return {
		ready: () => Boolean(vm) && !stopping && !failure,
		hostPath: (input) => {
			let value = stripAtPrefix(input.replace(/[  -   　]/g, " "));
			if (value.startsWith("file://")) value = fileURLToPath(value);
			return path.isAbsolute(value) && isInsideHostPath(GUEST_WORKSPACE, value)
				? path.join(localCwd, path.relative(GUEST_WORKSPACE, value)) : input;
		},
	};
}

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

// macOS commonly spells the same directory as /var/... and /private/var/....
// Resolve existing ancestors too, so new write targets map to the same mount.
function canonicalHostPath(value: string): string {
	let existing = value;
	const suffix: string[] = [];
	while (!existsSync(existing) && path.dirname(existing) !== existing) {
		suffix.unshift(path.basename(existing));
		existing = path.dirname(existing);
	}
	try { return path.join(realpathSync(existing), ...suffix); } catch { return value; }
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath);
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		const canonical = canonicalHostPath(trimmed);
		if (isInsideHostPath(localCwd, canonical)) return hostPathToGuest(localCwd, canonical);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string, cancelVm: (vm: VM) => Promise<void>): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			let cancelled: Promise<void> | undefined;
			const onAbort = () => {
				controller.abort();
				cancelled ??= cancelVm(vm);
				void cancelled.catch(() => {}); // Awaited before the operation returns.
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
						onAbort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: { TERM: "xterm-256color" },
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				await cancelled;
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
