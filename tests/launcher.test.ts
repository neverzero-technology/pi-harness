import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir, write } from "./helpers.ts";

const launcher = fileURLToPath(new URL("../bin/pi-team.mjs", import.meta.url));

function fakePi(version: string): string {
	const dir = tempDir();
	write(dir, "pi", `#!/bin/sh\necho "${version}"\n`);
	chmodSync(join(dir, "pi"), 0o755);
	return join(dir, "pi");
}

function launch(version: string, ...args: string[]) {
	const out = execFileSync(process.execPath, [launcher, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_TEAM_PI_BIN: fakePi(version), PI_TEAM_DRY_RUN: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out) as { args: string[] };
}

test("launcher isolates resources and pins the model", () => {
	const { args } = launch("0.99.2", "--continue");
	for (const flag of ["--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates"]) assert.ok(args.includes(flag), flag);
	assert.ok(args[args.indexOf("--extension") + 1].endsWith("extensions/team.ts"));
	assert.ok(args[args.indexOf("--skill") + 1].endsWith("skills"));
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
	assert.equal(args.at(-1), "--continue");
	assert.ok(!args.includes("--no-context-files"), "repo AGENTS.md files carry the domain invariants");
});

test("an explicit --model or --provider is respected rather than overridden", () => {
	assert.equal(launch("0.99.2", "--model", "other/model").args.filter((a) => a === "--model").length, 1);
	assert.ok(!launch("0.99.2", "--provider", "anthropic").args.includes("--model"));
	// After `--` the same words are message text, so the team model still applies.
	const { args } = launch("0.99.2", "--", "--model");
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
});

test("a missing host fails clearly", () => {
	assert.throws(
		() =>
			execFileSync(process.execPath, [launcher], {
				env: { ...process.env, PI_TEAM_PI_BIN: "/nonexistent/pi" },
				stdio: ["ignore", "pipe", "pipe"],
			}),
		/cannot run/,
	);
});

// A stand-in Pi that stays running; `trap` controls whether it exits by code or dies by the signal.
function longRunningPi(trap: boolean): { bin: string; marker: string } {
	const dir = tempDir();
	const qemu = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
	write(dir, qemu, "#!/bin/sh\necho 'QEMU test stub'\n");
	chmodSync(join(dir, qemu), 0o755);
	const marker = join(dir, "terminated");
	const body = trap ? `trap 'touch "${marker}"; exit 143' TERM\nsleep 30 &\nwait $!\n` : "exec sleep 30\n";
	write(dir, "pi", `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.99.2; exit 0; fi\nif [ "$1" = "--help" ]; then echo --team-preflight; exit 0; fi\ntouch "${join(dir, "started")}"\n${body}`);
	chmodSync(join(dir, "pi"), 0o755);
	return { bin: join(dir, "pi"), marker };
}

async function terminate(bin: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	const proc = spawn(process.execPath, [launcher], { env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH}`, PI_TEAM_PI_BIN: bin }, stdio: "ignore" });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		proc.on("exit", (code, signal) => resolve({ code, signal }));
	});
	const deadline = Date.now() + 10_000;
	while (!existsSync(join(dirname(bin), "started")) && proc.exitCode === null && Date.now() < deadline) await delay(20);
	assert.ok(existsSync(join(dirname(bin), "started")), "Pi started after prerequisite checks");
	proc.kill("SIGTERM");
	return exited;
}

test("launcher rejects extensions that could override the sandbox", () => {
	for (const flag of ["-e", "--extension", "--extension=unsafe.ts"]) {
		assert.throws(() => launch("0.99.2", flag, "unsafe.ts"), /not allowed/);
	}
	assert.equal(launch("0.99.2", "--", "--extension").args.at(-1), "--extension");
});

test("launcher refuses to start when Pi cannot load the mandatory harness", () => {
	const { bin } = longRunningPi(false);
	write(dirname(bin), "pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.99.2; exit 0; fi\nexit 0\n");
	assert.throws(() => execFileSync(process.execPath, [launcher], {
		env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH}`, PI_TEAM_PI_BIN: bin },
		stdio: ["ignore", "pipe", "pipe"],
	}), /did not load the mandatory harness extension.*host execution is blocked/);
	assert.equal(existsSync(join(dirname(bin), "started")), false);
});

test("a signal sent to the launcher reaches Pi, and the launcher ends the way Pi ended", async () => {
	const graceful = longRunningPi(true);
	assert.deepEqual(await terminate(graceful.bin), { code: 143, signal: null });
	assert.ok(existsSync(graceful.marker), "Pi received SIGTERM and shut down itself");

	const killed = longRunningPi(false);
	assert.deepEqual(await terminate(killed.bin), { code: null, signal: "SIGTERM" });
});

test("the launcher never reports success when Pi was killed by a signal Node ignores", async () => {
	const dir = tempDir();
	write(dir, "pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.99.2; exit 0; fi\nif [ "$1" = "--help" ]; then echo "--team-preflight"; exit 0; fi\nkill -PIPE $$\nsleep 5\n');
	chmodSync(join(dir, "pi"), 0o755);
	const proc = spawn(process.execPath, [launcher], { env: { ...process.env, PI_TEAM_PI_BIN: join(dir, "pi") }, stdio: "ignore" });
	const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
	assert.notDeepEqual(ended, { code: 0, signal: null });
});
