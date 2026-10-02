import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiscover } from "../src/commands/discover.ts";
import { registerReview } from "../src/commands/review.ts";
import { registerSpec } from "../src/commands/spec.ts";
import { registerTeamCommand } from "../src/commands/team.ts";
import { registerWork } from "../src/commands/work.ts";
import { guardToolCall } from "../src/modes.ts";
import { Team } from "../src/runtime.ts";
import { registerTools } from "../src/tools.ts";
import { registerSandbox, type SandboxOptions } from "../src/sandbox.ts";

export default function piTeam(pi: ExtensionAPI): void {
	registerTeam(pi);
}

export function registerTeam(pi: ExtensionAPI, sandboxOptions?: SandboxOptions): void {
	const sandbox = registerSandbox(pi, sandboxOptions);
	const team = new Team(pi);
	team.sandbox = sandbox;

	registerTools(team);
	registerWork(team);
	registerSpec(team);
	registerReview(team);
	registerDiscover(team);
	registerTeamCommand(team);

	pi.on("session_start", async (_event, ctx) => {
		team.restoreState(ctx);
		const repo = await team.loadRepo(ctx.cwd);
		if (!team.state.issue && repo) {
			const branch = await repo.git.run(["branch", "--show-current"]);
			const issue = team.issueKeyFrom(branch);
			if (issue) team.state = { ...team.state, issue };
		}
		team.showStatus(ctx);
		if (repo && ctx.hasUI) {
			if (repo.profileState.errors.length) ctx.ui.notify(`The repository profile is invalid (${repo.profileState.errors[0]}); /team doctor has the details.`, "warning");
			else if (!repo.profile) ctx.ui.notify("This repository has not adopted the workflow yet (no .pi-team/profile.json). Run /discover.", "info");
		}
		const pending = repo?.pending.list() ?? [];
		if (pending.length && ctx.hasUI) {
			ctx.ui.notify(
				`Unsynced checkpoint(s): ${pending.map((p) => `${p.issue} ${p.id}`).join(", ")}. Shared progress is not confirmed; run /work resume.`,
				"warning",
			);
		}
	});

	// Compaction drops detail. Durable state lives in Linear, so say when this session has work no checkpoint covers.
	pi.on("session_before_compact", async (_event, ctx) => {
		if (!team.state.issue || !team.repo || !ctx.hasUI) return;
		const git = await team.repo.git.state();
		if (!git) return;
		const dirty = git.changed.length + git.untracked.length > 0;
		if (dirty || git.head !== team.checkpointedHead) {
			ctx.ui.notify(`Context is being compacted and ${team.state.issue} has work since the last checkpoint of this session. Run /work checkpoint.`, "warning");
		}
	});

	pi.on("session_compact", async () => {
		if (!team.state.issue) return;
		pi.sendMessage(
			{
				customType: "pi-team",
				content: `Context was compacted. This session works ${team.state.issue} in ${team.state.mode} mode. Re-read the acceptance with team_issue_read before continuing; /work resume reloads the full briefing.`,
				display: true,
			},
			{ triggerTurn: false },
		);
	});

	pi.on("session_tree", async (_event, ctx) => {
		team.restoreState(ctx);
		team.showStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const decision = guardToolCall({
			mode: team.state.mode,
			toolName: event.toolName,
			input: {
				...input,
				...(typeof input.path === "string" ? { path: sandbox.hostPath(input.path) } : {}),
			},
			cwd: ctx.cwd,
			repoRoot: team.repo?.root,
			generated: team.repo?.profile?.generated ?? [],
			specDirs: ["docs"],
		});
		if (decision.action === "allow") return undefined;
		if (decision.action === "confirm" && ctx.hasUI && (await ctx.ui.confirm(decision.title, decision.message))) return undefined;
		if (ctx.hasUI) ctx.ui.notify(decision.reason, "warning");
		return { block: true, reason: decision.reason };
	});
}
