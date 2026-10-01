import assert from "node:assert/strict";
import { readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { VM, VMOptions } from "@earendil-works/gondolin";
import { sandboxHost } from "./sandbox-helpers.ts";
import { git, repoWithOrigin, tempDir, write } from "./helpers.ts";


test("a failed VM blocks every tool, shell commands and model startup without host fallback", async () => {
	const cwd = tempDir();
	write(cwd, "sentinel", "unchanged");
	let starts = 0;
	const h = sandboxHost(cwd, { createVm: async () => { starts++; throw new Error("no QEMU"); } });
	await assert.rejects(h.emit("session_start"), /sandbox unavailable.*no QEMU/);
	for (const [name, params] of [
		["read", { path: "sentinel" }], ["write", { path: "sentinel", content: "changed" }],
		["edit", { path: "sentinel", edits: [{ oldText: "unchanged", newText: "changed" }] }],
		["bash", { command: "touch escaped" }], ["grep", { pattern: "unchanged" }],
		["find", { pattern: "*" }], ["ls", {}],
	] as const) await assert.rejects(h.call(name, params), /Host execution is blocked/);
	await assert.rejects(h.emit("user_bash", { command: "touch escaped" }), /Host execution is blocked/);
	await assert.rejects(h.emit("before_agent_start", { systemPrompt: "prompt" }), /Host execution is blocked/);
	assert.equal(starts, 1, "a startup failure cannot silently retry with another backend");
	assert.equal(readFileSync(join(cwd, "sentinel"), "utf8"), "unchanged");
	assert.equal(h.handle.ready(), false);
	await h.emit("session_shutdown");
});

test("reviewer mounts and harness resources reject writes and symlink escapes", async () => {
	const cwd = tempDir();
	const outside = tempDir();
	write(cwd, "sentinel", "unchanged");
	write(outside, "secret", "host-only");
	symlinkSync(join(outside, "secret"), join(cwd, "escape"));
	let mounted: VMOptions | undefined;
	const h = sandboxHost(cwd, { readOnly: true, createVm: async (options) => {
		mounted = options;
		return { exec: async () => ({ stdout: "/bin/sh\n" }), close: async () => {} } as unknown as VM;
	} });
	await h.emit("session_start");
	const provider = mounted!.vfs!.mounts!["/workspace"];
	assert.equal(provider.readonly, true);
	await assert.rejects(provider.open("sentinel", "w"), /read-only|EROFS|ERRNO_30/i);
	await assert.rejects(provider.open("escape", "r"));
	assert.equal(readFileSync(join(cwd, "sentinel"), "utf8"), "unchanged");
	assert.deepEqual([...h.tools.keys()].sort(), ["find", "grep", "ls", "read"]);
	await assert.rejects(h.call("write", {}), /sandbox tool policy/);
	await assert.rejects(h.call("team_checkpoint", {}), /sandbox tool policy/);
	await assert.rejects(h.emit("user_bash"), /disabled/);
	for (const [path, provider] of Object.entries(mounted!.vfs!.mounts!)) {
		if (path !== "/workspace" && path !== cwd) assert.equal(provider.readonly, true);
	}
	await h.emit("session_shutdown");
});

test("linked worktrees mount only their shared Git metadata, and guest paths map to host guards", async () => {
	const { root } = repoWithOrigin();
	const worktree = join(tempDir(), "worktree");
	git(root, "worktree", "add", "-qb", "feature", worktree);
	let mounted: VMOptions | undefined;
	let closed = 0;
	const h = sandboxHost(worktree, { createVm: async (options) => {
		mounted = options;
		return { exec: async () => ({ exitCode: 0, stdout: "/bin/bash\n" }), close: async () => { closed++; } } as unknown as VM;
	} });
	await Promise.all([h.emit("session_start"), h.emit("session_start")]);
	assert.ok(mounted!.vfs!.mounts![realpathSync(join(root, ".git"))]);
	assert.ok(!mounted!.vfs!.mounts![root]);
	assert.equal(h.handle.hostPath("/workspace/docs/a.md"), join(realpathSync(worktree), "docs/a.md"));
	assert.equal(h.handle.hostPath("/workspace-other/a.md"), "/workspace-other/a.md");
	assert.equal(h.handle.hostPath("/tmp/a.md"), "/tmp/a.md");
	await h.emit("session_shutdown");
	await h.emit("session_shutdown");
	assert.equal(closed, 1);
	await assert.rejects(h.call("read", { path: "README.md" }), /shutting down/);
});

test("guest shells receive an explicit environment, never host credentials or PATH", async () => {
	const cwd = tempDir();
	const calls: any[] = [];
	const h = sandboxHost(cwd, { createVm: async (options) => {
		assert.deepEqual(options.env, { TERM: "xterm-256color" });
		return {
			exec(args: string[], opts: any) {
				calls.push({ args, opts });
				return Object.assign(Promise.resolve({ exitCode: 0, stdout: "/bin/bash\n" }), { output: async function* () { yield { data: Buffer.from("guest output") }; } });
			},
			close: async () => {},
		} as unknown as VM;
	} });
	const { operations } = await h.emit("user_bash");
	const chunks: Buffer[] = [];
	const result = await operations.exec("echo hello", cwd, { onData: (data: Buffer) => chunks.push(data), env: { LINEAR_API_KEY: "secret", OPENAI_API_KEY: "secret", PATH: "/host/bin" } });
	assert.equal(result.exitCode, 0);
	assert.equal(Buffer.concat(chunks).toString(), "guest output");
	assert.deepEqual(calls.at(-1).opts.env, { TERM: "xterm-256color" });
	assert.equal(calls.at(-1).opts.cwd, "/workspace");
	await assert.rejects(h.call("powershell", { command: "echo host" }), /sandbox tool policy/);
	await h.emit("session_shutdown");
});

test("a shell timeout closes the VM before another command can start", async () => {
	const cwd = tempDir();
	let starts = 0;
	let closed = 0;
	const h = sandboxHost(cwd, { createVm: async () => {
		starts++;
		return {
			exec(args: string[], opts: any) {
				if (args.at(-1) !== "hang") return Object.assign(Promise.resolve({ exitCode: 0, stdout: "/bin/bash\n" }), { output: async function* () {} });
				const pending = new Promise<never>((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("guest wait aborted")), { once: true }));
				return Object.assign(pending, { output: async function* () { await pending; } });
			},
			close: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); closed++; },
		} as unknown as VM;
	} });
	const { operations } = await h.emit("user_bash");
	await assert.rejects(operations.exec("hang", cwd, { onData: () => {}, timeout: 0.01 }), /timeout:0.01/);
	assert.equal(closed, 1, "timeout does not return while guest processes can still run");
	assert.equal(h.handle.ready(), false);
	await h.emit("user_bash");
	assert.equal(starts, 2);
	assert.equal(h.handle.ready(), true);
	await h.emit("session_shutdown");
	assert.equal(closed, 2);
});
