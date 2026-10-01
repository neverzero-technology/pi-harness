import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CheckResult } from "./checkpoint.ts";
import type { Profile } from "./config.ts";
import { PACKAGE_ROOT } from "./config.ts";

// The reviewer is a fresh Pi with a read-only Gondolin VM and no team/Linear tools.

export const REVIEW_TOOLS = ["read", "grep", "find", "ls"];
export const MAX_DIFF_BYTES = 200_000;

export interface ReviewPacketInput {
	issue: string;
	title: string;
	url: string;
	acceptance: string;
	spec: string | undefined;
	profile: Profile | undefined;
	head: string;
	base: string;
	dirtyFiles: string[];
	checkpoint: string | undefined;
	checks: CheckResult[]; // the latest recorded result of each command, across all checkpoints
	diff: string;
	diffTruncated: boolean;
	diffStat: string;
}

export function buildReviewPacket(p: ReviewPacketInput): string {
	const sections = [
		`# Review packet: ${p.issue} — ${p.title}`,
		p.url,
		"",
		"## Acceptance (from the Linear issue)",
		p.acceptance || "(The issue has no description. Treat missing acceptance as a finding.)",
		"",
		"## Specification",
		p.spec
			? `Read \`${p.spec}\` in this repository. The requirement IDs in the issue refer to it.`
			: "No change specification; the issue text is the acceptance.",
		"",
	];
	if (p.profile) {
		sections.push(
			`## Repository constraints (${p.profile.name})`,
			...p.profile.invariants.map((i) => `- ${i}`),
			"",
			`Authoritative documents: ${p.profile.docs.map((d) => `\`${d}\``).join(", ")}`,
			p.profile.generated.length ? `Generated paths (must not be hand-edited): ${p.profile.generated.join(", ")}` : "",
			"",
		);
	}
	sections.push(
		"## Tested source",
		`HEAD \`${p.head}\`, diff base \`${p.base}\`.`,
		p.dirtyFiles.length
			? `Uncommitted changes are present and included in the diff: ${p.dirtyFiles.join(", ")}`
			: "No uncommitted changes.",
		"",
		"## Recorded checks (latest result of each command)",
		...(p.checks.length
			? p.checks.map((c) => `- \`${c.command}\`: ${c.result} (${c.scope}) at ${c.commit ?? "unknown commit"}${c.dirty ? ", on a tree with uncommitted changes" : ""}${c.commit && p.head.startsWith(c.commit) ? "" : " — not this HEAD"}`)
			: ["None recorded. Treat missing verification evidence as a finding."]),
		"",
		"## Latest checkpoint",
		p.checkpoint ?? "No checkpoint recorded.",
		"",
		"## Changed files",
		"```",
		p.diffStat || "(none)",
		"```",
		"",
		"## Diff",
		p.diffTruncated
			? `The diff was truncated at ${MAX_DIFF_BYTES} bytes. Read the changed files listed above for the remainder.`
			: "",
		"```diff",
		p.diff || "(empty)",
		"```",
	);
	return sections.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}

export interface ReviewRun {
	output: string;
	exitCode: number;
	stderr: string;
	model?: string;
}

export function piInvocation(args: string[]): { command: string; args: string[] } {
	// PI_TEAM_REVIEWER_BIN substitutes the reviewer alone (tests); PI_TEAM_PI_BIN is the Pi the launcher was told to use.
	const override = process.env.PI_TEAM_REVIEWER_BIN ?? process.env.PI_TEAM_PI_BIN;
	if (override) return { command: override, args };
	// Re-run the Pi that is hosting this session, so the reviewer uses the same version.
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function reviewerEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.LINEAR_API_KEY;
	return env;
}

export async function runReviewer(options: {
	cwd: string;
	packet: string;
	systemPrompt: string;
	model: string;
	thinking: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<ReviewRun> {
	const dir = mkdtempSync(join(tmpdir(), "pi-team-review-"));
	const packetFile = join(dir, "packet.md");
	writeFileSync(packetFile, options.packet);
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		join(PACKAGE_ROOT, "extensions", "reviewer.ts"),
		"--no-skills",
		"--no-prompt-templates",
		"--no-approve",
		"--tools",
		REVIEW_TOOLS.join(","),
		"--model",
		options.model,
		"--thinking",
		options.thinking,
		"--append-system-prompt",
		options.systemPrompt,
		`@${packetFile}`,
		"Review the proposed change described in the attached packet. Follow the reviewer instructions exactly.",
	];
	const invocation = piInvocation(args);
	try {
		// Pi can continue with built-in tools after an extension import fails.
		// Require registration under its own loader before starting any model turn.
		const preflight = piInvocation(["--help", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", join(PACKAGE_ROOT, "extensions", "reviewer.ts")]);
		const loaded = spawnSync(preflight.command, preflight.args, { cwd: options.cwd, env: reviewerEnv(), encoding: "utf8", timeout: 30_000 });
		if (loaded.error || loaded.status !== 0 || !loaded.stdout.includes("--team-reviewer-sandbox")) {
			return { output: "", exitCode: 1, stderr: `Reviewer sandbox failed to load; review execution is blocked. ${loaded.error?.message ?? loaded.stderr.trim()}` };
		}
		return await new Promise<ReviewRun>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: reviewerEnv(),
			});
			let buffer = "";
			let stderr = "";
			let output = "";
			let model: string | undefined;
			const timer = setTimeout(() => proc.kill("SIGTERM"), options.timeoutMs ?? 20 * 60_000);
			options.signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
			const handle = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { type?: string; message?: { role?: string; model?: string; content?: Array<{ type: string; text?: string }> } };
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const text = (event.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
						if (text.trim()) output = text;
						model = event.message.model ?? model;
					}
				} catch {
					// Non-JSON lines are diagnostics; keep them with stderr.
					stderr += `${line}\n`;
				}
			};
			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				lines.forEach(handle);
			});
			proc.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				handle(buffer);
				resolve({ output, exitCode: code ?? 1, stderr: stderr.slice(-4000), model });
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				resolve({ output: "", exitCode: 1, stderr: error.message });
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
