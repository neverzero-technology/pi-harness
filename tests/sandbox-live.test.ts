import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VM } from "@earendil-works/gondolin";
import { PACKAGE_ROOT } from "../src/config.ts";
import { git, repoWithOrigin, tempDir, write } from "./helpers.ts";
import { sandboxHost } from "./sandbox-helpers.ts";

test("real Gondolin isolates tools, supports worktrees and cancels guest processes", { skip: !process.env.PI_TEAM_SANDBOX_E2E, timeout: 180_000 }, async () => {
	const { root } = repoWithOrigin();
	const cwd = join(tempDir(), "worktree");
	git(root, "worktree", "add", "-qb", "sandbox-live", cwd);
	const outside = tempDir();
	write(outside, "secret", "host-only");
	symlinkSync(join(outside, "secret"), join(cwd, "escape"));
	const previous = process.env.LINEAR_API_KEY;
	process.env.LINEAR_API_KEY = "sandbox-live-secret";
	const h = sandboxHost(cwd);
	try {
		await h.emit("session_start");
		assert.equal(h.handle.ready(), true);
		await h.call("write", { path: "src/example.txt", content: "hello guest\n" });
		await h.call("edit", { path: "/workspace/src/example.txt", edits: [{ oldText: "hello guest", newText: "hello VM" }] });
		assert.equal(readFileSync(join(cwd, "src/example.txt"), "utf8"), "hello VM\n");
		assert.match((await h.call("read", { path: join(cwd, "src/example.txt") })).content[0].text, /hello VM/);
		assert.match((await h.call("grep", { pattern: "hello", path: "src" })).content[0].text, /hello VM/);
		assert.match((await h.call("find", { pattern: "*.txt", path: "src" })).content[0].text, /example.txt/);
		assert.match((await h.call("ls", { path: "src" })).content[0].text, /example.txt/);
		assert.match((await h.call("read", { path: join(PACKAGE_ROOT, "skills/delivery/SKILL.md") })).content[0].text, /delivery|checkpoint/i);
		await assert.rejects(h.call("read", { path: join(outside, "secret") }));
		await assert.rejects(h.call("read", { path: "escape" }));
		const output = (await h.call("bash", { command: "uname -s; git branch --show-current; node --version; test -z \"$LINEAR_API_KEY\" && echo NO_HOST_KEY" })).content[0].text;
		assert.match(output, /Linux/);
		assert.match(output, /sandbox-live/);
		assert.match(output, /NO_HOST_KEY/);
		const { operations } = await h.emit("user_bash");
		const controller = new AbortController();
		const running = operations.exec("sleep 3; touch /workspace/escaped-after-abort", cwd, { onData: () => {}, signal: controller.signal });
		const timer = setTimeout(() => controller.abort(), 200);
		await assert.rejects(running, /aborted/);
		clearTimeout(timer);
		await h.call("bash", { command: "sleep 4" });
		assert.equal(existsSync(join(cwd, "escaped-after-abort")), false);
	} finally {
		await h.emit("session_shutdown");
		if (previous === undefined) delete process.env.LINEAR_API_KEY;
		else process.env.LINEAR_API_KEY = previous;
	}
	let reviewVm: VM | undefined;
	const reviewer = sandboxHost(cwd, { readOnly: true, createVm: async (options) => {
		reviewVm = await VM.create(options);
		return reviewVm;
	} });
	try {
		await reviewer.emit("session_start");
		assert.match((await reviewer.call("read", { path: "README.md" })).content[0].text, /hello/);
		await assert.rejects(reviewer.call("write", { path: "README.md", content: "bad" }), /sandbox tool policy/);
		await assert.rejects(reviewer.emit("user_bash"), /disabled/);
		const denied = await reviewVm!.exec(["/bin/sh", "-c", "echo changed > /workspace/README.md"]);
		assert.notEqual(denied.exitCode, 0, "the reviewer workspace mount itself rejects writes");
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello\n");
	} finally { await reviewer.emit("session_shutdown"); }
});
