#!/usr/bin/env node
// Launch Pi with only the team's approved resources: this package's extension and skills, the pinned
// model, and no automatically discovered personal or project extensions, skills, prompts or MCP servers.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const team = JSON.parse(readFileSync(process.env.PI_TEAM_CONFIG || join(root, "team.json"), "utf8"));
const pi = process.env.PI_TEAM_PI_BIN || "pi";
const passthrough = process.argv.slice(2);

const probe = spawnSync(pi, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.error(`pi-team: cannot run "${pi}". Install Pi ${team.host.piVersion} or set PI_TEAM_PI_BIN.`);
	process.exit(1);
}
const version = probe.stdout.trim().split(/\s+/).pop();
if (version !== team.host.piVersion) {
	console.error(`pi-team: warning: Pi ${version} is not the tested ${team.host.piVersion}. /team doctor reports the difference.`);
}

function launchArgs(options = {}) {
	const args = [
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--extension",
		join(root, "extensions", "team.ts"),
		"--skill",
		join(root, "skills"),
	];
	if (!team.launcher.contextFiles) args.push("--no-context-files");
	if (!options.hasModel) args.push("--model", team.model.id);
	if (!options.hasThinking) args.push("--thinking", team.model.thinking);
	return args;
}

// Only flags before a `--` separator are options; after it they are message text.
const separator = passthrough.indexOf("--");
const flags = separator === -1 ? passthrough : passthrough.slice(0, separator);
// An extra extension could replace the sandbox tool implementations by name.
// The harness loads only its bundled resources; model/session options still pass through.
const resourceFlag = flags.find((arg) => /^(?:-e|--extension|--skill|--prompt-template)(?:=|$)/.test(arg));
if (resourceFlag) {
	console.error(`pi-team: ${resourceFlag} is not allowed; the harness enforces its bundled Gondolin sandbox and resources.`);
	process.exit(1);
}
// Since Pi 1.0, --provider only narrows where --model is looked up, and Pi rejects it on its own.
if (flags.includes("--provider") && !flags.includes("--model")) {
	console.error(`pi-team: --provider needs --model. Omit both to use the team model (${team.model.id}).`);
	process.exit(1);
}
const args = [
	...launchArgs({
		hasModel: flags.includes("--model"),
		hasThinking: flags.includes("--thinking"),
	}),
	...passthrough,
];
if (process.env.PI_TEAM_DRY_RUN) {
	console.log(JSON.stringify({ pi, args }));
	process.exit(0);
}
if (Number(process.versions.node.split(".")[0]) < 24) {
	console.error("pi-team: Node >=24 is required for Gondolin.");
	process.exit(1);
}
if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
	console.error("pi-team: Gondolin requires macOS or Linux on arm64/x64.");
	process.exit(1);
}
const qemu = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
const qemuProbe = spawnSync(qemu, ["--version"], { encoding: "utf8" });
if (qemuProbe.error || qemuProbe.status !== 0) {
	console.error(`pi-team: ${qemu} is required. Install QEMU (macOS: brew install qemu); see README prerequisites. Host execution is blocked.`);
	process.exit(1);
}
try {
	await import("@earendil-works/gondolin");
	// Pi resolves peer imports for packaged extensions. Its help mode loads the
	// factory without session_start; the marker confirms registration succeeded.
	const load = spawnSync(pi, ["--help", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", join(root, "extensions", "preflight.ts")], { encoding: "utf8", timeout: 30_000 });
	if (load.error || load.status !== 0 || !load.stdout.includes("--team-preflight")) throw new Error(load.error?.message ?? (load.stderr.trim() || "Pi did not load the mandatory harness extension"));
} catch (error) {
	console.error(`pi-team: cannot load the sandbox/harness: ${error.message}. Run npm install; host execution is blocked.`);
	process.exit(1);
}
const child = spawn(pi, args, { stdio: "inherit", env: { ...process.env, PI_TEAM_LAUNCHER: version } });
// Ctrl-C reaches Pi directly through the terminal, so the launcher only has to stay out of the way.
// Signals sent to the launcher alone are passed on, and it ends the way Pi ended.
const forward = { SIGINT: () => {}, SIGTERM: () => child.kill("SIGTERM"), SIGHUP: () => child.kill("SIGHUP") };
for (const [signal, handler] of Object.entries(forward)) process.on(signal, handler);
child.on("error", (error) => {
	console.error(`pi-team: could not start Pi: ${error.message}`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (!signal) process.exit(code ?? 0);
	for (const [name, handler] of Object.entries(forward)) process.off(name, handler);
	process.kill(process.pid, signal);
	// Node ignores some signals (SIGPIPE, for one), so re-raising them does not end this process.
	// Pi did not exit cleanly either way, so never report success.
	setTimeout(() => process.exit(1), 100);
});
