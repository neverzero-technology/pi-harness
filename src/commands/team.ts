import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, readPackageVersion } from "../config.ts";
import { PROFILE_PATH } from "../profile.ts";
import type { IssueRef } from "../linear.ts";
import { MODES, type Mode } from "../modes.ts";
import { errorText, type Team, TeamError } from "../runtime.ts";
import { SANDBOX_TOOLS } from "../sandbox.ts";

export function registerTeamCommand(team: Team): void {
	team.pi.registerCommand("team", {
		description: "Team workflow: doctor | status | version | setup | mode <implement|spec|review>",
		getArgumentCompletions: (prefix) =>
			["doctor", "status", "version", "setup", "mode"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "doctor", value] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (sub === "doctor") return await doctor(team, ctx);
				if (sub === "status") return await teamStatus(team, ctx);
				if (sub === "version") {
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
					team.report(`@neverzero/pi-team ${readPackageVersion()} · Pi ${await hostVersion()} (tested ${team.config.host.piVersion}) · model ${model} (team ${team.config.model.id})`);
					return;
				}
				if (sub === "setup") {
					team.report(SETUP);
					return;
				}
				if (sub === "mode") {
					if (!value) {
						ctx.ui.notify(`Mode: ${team.state.mode}`, "info");
						return;
					}
					if (!MODES.includes(value as Mode)) throw new TeamError(`Modes: ${MODES.join(", ")}`);
					team.setState({ mode: value as Mode }, ctx);
					ctx.ui.notify(`Mode: ${value}`, "info");
					return;
				}
				throw new TeamError("Usage: /team doctor | status | version | setup | mode <implement|spec|review>");
			} catch (error) {
				ctx.ui.notify(`/team ${sub}: ${errorText(error)}`, error instanceof TeamError ? "warning" : "error");
			}
		},
	});
}

const SETUP = [
	"Individual setup. Credentials are personal: never share auth.json, keys or tokens, and never paste them into a session.",
	"",
	"1. Codex: in a terminal run `pi`, then `/login`, and choose openai-codex.",
	"2. Linear: Settings → Security & access → Personal API keys → New key. Then either",
	"   `export LINEAR_API_KEY=…` in your shell profile, or save it to ~/.config/pi-team/linear-api-key and `chmod 600` it.",
	"3. GitHub: `gh auth login`.",
	"4. Install Node >=24 and QEMU (`brew install node qemu` on macOS). First use downloads Gondolin guest assets.",
	"5. Start `pi-team` inside a team repository and run /team doctor. All repository tools and ! commands require Gondolin.",
].join("\n");

function hostVersion(): Promise<string> {
	return import("@earendil-works/pi-coding-agent").then(
		(m) => m.VERSION,
		() => "unknown",
	);
}

type Mark = "ok" | "warn" | "fail";

async function doctor(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const rows: Array<[Mark, string, string]> = [];
	const add = (mark: Mark, label: string, detail: string) => rows.push([mark, label, detail]);
	const { config } = team;

	add("ok", "Package", `@neverzero/pi-team ${readPackageVersion()} (${PACKAGE_ROOT})`);
	const host = await hostVersion();
	add(host === config.host.piVersion ? "ok" : "warn", "Pi host", `${host} (tested: ${config.host.piVersion})`);
	const launcher = process.env.PI_TEAM_LAUNCHER;
	add(launcher ? "ok" : "warn", "Launcher", launcher ? "pi-team (isolated resources)" : "plain pi: personal extensions, skills and MCP servers may also be active");
	add(team.sandbox?.ready() ? "ok" : "fail", "Sandbox", team.sandbox?.ready() ? "Gondolin VM ready; repository tools and ! commands run in Linux" : "Gondolin is unavailable; tool execution is blocked");

	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	add(model === config.model.id ? "ok" : "warn", "Model", `${model} · thinking ${team.pi.getThinkingLevel()} (team: ${config.model.id}, ${config.model.thinking})`);
	const [provider, ...idParts] = config.model.id.split("/");
	const teamModel = ctx.modelRegistry.find(provider, idParts.join("/"));
	if (!teamModel) add("fail", "Model access", `${config.model.id} is not a model this Pi knows; run \`pi update\` or fix team.json`);
	else if (!ctx.modelRegistry.hasConfiguredAuth(teamModel)) add("fail", "Model access", `Not signed in to ${provider}; see /team setup`);
	else add("ok", "Model access", `Signed in to ${provider}`);

	const repo = await team.loadRepo(ctx.cwd);
	if (!repo) add("warn", "Repository", "Not inside a git repository");
	else {
		add("ok", "Repository", `${repo.root} · ${repo.origin ?? "no origin"} · default branch ${repo.defaultRef}`);
		const state = repo.profileState;
		if (state.errors.length) add("fail", "Profile", `${PROFILE_PATH} (${state.source}) is invalid: ${state.errors.join("; ")}`);
		else if (!repo.profile) add("warn", "Profile", `No ${PROFILE_PATH}: this repository has not adopted the workflow. Run /discover.`);
		else if (state.source === "working-tree") add("warn", "Profile", `${repo.profile.name}, from the working tree; it takes effect for everyone once merged to ${repo.defaultRef}`);
		else add(state.unmerged ? "warn" : "ok", "Profile", `${repo.profile.name}, from ${repo.defaultRef}${state.unmerged ? "; the working tree has unmerged profile changes, which are not in force" : ""}`);
		const pending = repo.pending.list();
		add(pending.length ? "warn" : "ok", "Pending checkpoints", pending.length ? pending.map((p) => `${p.issue} ${p.id}`).join(", ") : "none");
	}

	const key = team.linearKeySource();
	if (!key) add("fail", "Linear", "No API key; see /team setup");
	else {
		try {
			const linear = team.linear();
			const viewer = await team.viewer();
			add("ok", "Linear identity", `${viewer.name} <${viewer.email}> via ${key.source.startsWith("/") ? "key file" : key.source}`);
			const linearTeam = await linear.team(config.linear.teamKey);
			if (!linearTeam) add("fail", "Linear team", `No team with key ${config.linear.teamKey} (team.json linear.teamKey)`);
			else {
				const states = await linear.workflowStates(linearTeam.key);
				const missing = Object.entries(config.linear.states).filter(([, name]) => !states.some((s) => s.name.toLowerCase() === name.toLowerCase()));
				add(missing.length ? "fail" : "ok", "Workflow states", missing.length ? `Missing: ${missing.map(([k, n]) => `${k}="${n}"`).join(", ")}` : "All mapped");
				const labels = [config.linear.blockedLabel, ...(repo?.profile ? [repo.profile.linear.label] : [])];
				for (const label of labels) {
					const id = await linear.labelId(label, linearTeam.id);
					add(id ? "ok" : "warn", "Label", `${label}${id ? "" : " not found"}`);
				}
			}
		} catch (error) {
			add("fail", "Linear", errorText(error));
		}
	}

	if (repo) add((await repo.gh.authenticated()) ? "ok" : "fail", "GitHub CLI", "gh auth status");

	const foreignTools = team.pi
		.getAllTools()
		.filter((t) => !t.sourceInfo.path.startsWith("builtin:") && !t.name.startsWith("team_") && !SANDBOX_TOOLS.includes(t.name))
		.map((t) => t.name);
	add(foreignTools.length ? "warn" : "ok", "Other tools", foreignTools.length ? foreignTools.join(", ") : "none");
	const linearish = team.pi.getAllTools().filter((t) => /linear/i.test(t.name) && !t.name.startsWith("team_"));
	if (linearish.length) add("warn", "Linear tools", `${linearish.map((t) => t.name).join(", ")} are blocked in team sessions`);

	const icon = { ok: "✓", warn: "!", fail: "✗" };
	const failures = rows.filter((r) => r[0] === "fail").length;
	team.report([`/team doctor: ${failures ? `${failures} problem(s)` : "ready"}`, "", ...rows.map(([m, l, d]) => `${icon[m]} ${l}: ${d}`)].join("\n"));
}

async function teamStatus(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const linear = team.linear();
	const { teamKey, states, blockedLabel } = team.config.linear;
	const byState = async (logical: "inProgress" | "inReview" | "ready") =>
		linear.issues({ team: { key: { eq: teamKey } }, state: { id: { eq: await team.stateId(teamKey, logical) } } });
	const [active, review, ready] = await Promise.all([byState("inProgress"), byState("inReview"), byState("ready")]);
	const fmt = (i: IssueRef) => {
		const flags = [
			i.labels.some((l) => l.toLowerCase() === blockedLabel.toLowerCase()) ? "BLOCKED" : "",
			i.openBlockers?.length ? `waiting on ${i.openBlockers.join(", ")}` : "",
			i.labels.find((l) => l.startsWith("repo:")) ?? "",
		].filter(Boolean);
		return `- ${i.identifier} ${i.title} · ${i.assignee?.name ?? "UNASSIGNED"}${flags.length ? ` · ${flags.join(" · ")}` : ""} · updated ${i.updatedAt?.slice(0, 10) ?? "?"}`;
	};
	const byPerson = new Map<string, number>();
	for (const i of active) byPerson.set(i.assignee?.name ?? "unassigned", (byPerson.get(i.assignee?.name ?? "unassigned") ?? 0) + 1);
	const multi = [...byPerson].filter(([, n]) => n > 1);
	const out = [
		`Team ${teamKey}`,
		"",
		`${states.inProgress} (${active.length}):`,
		...active.map(fmt),
		"",
		`${states.inReview} (${review.length}):`,
		...review.map(fmt),
		"",
		`${states.ready}: ${ready.length}${ready.more ? "+" : ""} (${ready.filter((i) => !i.assignee).length} unassigned)`,
	];
	if (multi.length) out.push("", `More than one active issue: ${multi.map(([p, n]) => `${p} (${n})`).join(", ")}`);
	if (active.more || review.more || ready.more) out.push("", "More issues match than are shown; see Linear for the full lists.");
	const repo = await team.requireRepo(ctx).catch(() => undefined);
	const pending = repo?.pending.list() ?? [];
	if (pending.length) out.push("", `Unsynced local checkpoints: ${pending.map((p) => `${p.issue} ${p.id}`).join(", ")}`);
	team.report(out.join("\n"));
}
