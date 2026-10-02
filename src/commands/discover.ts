import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { redactSecrets } from "../checkpoint.ts";
import { globToRegExp, repoNameFromOrigin } from "../config.ts";
import { ADOPT_BRANCH, adoptionPrBody, type DiscoverReport, formatInventory, inventory, parseNameStatus, unaccountedDeletions } from "../discover.ts";
import type { IssueRef } from "../linear.ts";
import { isOpen, LinearError } from "../linear.ts";
import { formatMetadata, parseMetadata } from "../metadata.ts";
import { PROFILE_GUIDE, PROFILE_PATH } from "../profile.ts";
import { errorText, type RepoContext, type Team, TeamError } from "../runtime.ts";

const text = (value: string, isError = false) => ({
	content: [{ type: "text" as const, text: value }],
	details: undefined,
	...(isError ? { isError: true } : {}),
});

const SUBCOMMANDS = ["scan", "linear", "status", "pr"];

export function registerDiscover(team: Team): void {
	team.pi.registerCommand("discover", {
		description: "Adopt this workflow in an existing repository: scan | linear | status | pr",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "scan";
			try {
				if (sub === "scan") return await scan(team, ctx);
				if (sub === "linear") return await linear(team, ctx);
				if (sub === "status") return await status(team, ctx);
				if (sub === "pr") return await pr(team, ctx);
				throw new TeamError(`Usage: /discover ${SUBCOMMANDS.join(" | ")}`);
			} catch (error) {
				ctx.ui.notify(`/discover ${sub}: ${errorText(error)}`, error instanceof TeamError ? "warning" : "error");
			}
		},
	});
	registerDiscoverTools(team);
}

async function onAdoptBranch(repo: RepoContext): Promise<void> {
	const branch = await repo.git.run(["branch", "--show-current"]);
	if (branch !== ADOPT_BRANCH) throw new TeamError(`This step runs on ${ADOPT_BRANCH}; start with /discover`);
}

async function scan(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await team.requireRepo(ctx);
	const base = repo.defaultRef.replace(/^origin\//, "");
	await repo.git.fetch("origin", base);
	const git = await repo.git.state();
	if (!git) throw new TeamError("Not inside a git repository");
	if (git.branch !== ADOPT_BRANCH) {
		// The adoption is one reviewable change, so it starts from a clean copy of the default branch.
		if (git.changed.length + git.untracked.length) throw new TeamError("Commit or stash your changes first; /discover works on its own branch from a clean checkout");
		const exists = await repo.git.ok(["rev-parse", "--verify", "--quiet", `refs/heads/${ADOPT_BRANCH}`]);
		const switched = await repo.git.switchTo(ADOPT_BRANCH, repo.defaultRef, exists);
		if (switched.code !== 0) throw new TeamError(`Could not switch to ${ADOPT_BRANCH}: ${switched.stderr.trim()}`);
	}
	const found = inventory(await repo.git.trackedFiles());
	const name = repo.profile?.name ?? repoNameFromOrigin(repo.origin) ?? "this-repository";
	team.setState({ mode: "discover", issue: undefined }, ctx);
	team.report(
		[
			`/discover: on ${ADOPT_BRANCH}, from ${repo.defaultRef}.`,
			repo.profile ? `This repository already has a profile (${repo.profile.name}); the scan proposes an update.` : "This repository has no profile yet.",
			"",
			formatInventory(found),
		].join("\n"),
	);
	team.ask(
		[
			`Adopt the team workflow in this repository, following the discovery skill at ${team.resource("skills", "discovery", "SKILL.md")}.`,
			`The inventory above lists what was found by name; read the repository to find anything it missed.`,
			"",
			`Write ${PROFILE_PATH} in this shape (suggested name: "${name}"):`,
			PROFILE_GUIDE,
			"",
			`Templates: ${team.resource("templates", "change-specification.md")} and ${team.resource("templates", "capability-specification.md")}.`,
			`Linear team key: ${team.config.linear.teamKey}. Do not create anything in Linear in this step.`,
			"Discover mode is on: you may write under .pi-team/, docs/, .github/ and root-level Markdown files, and delete old harness files with git. Product source is off limits.",
			"Leave task ledgers in place for now: they are removed in /discover linear, once their open work is in Linear.",
			"Finish by calling team_discover_report, committing your work, and telling the human to run /discover linear and then /discover pr.",
		].join("\n"),
		ctx,
	);
}

async function linear(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await team.requireRepo(ctx);
	await onAdoptBranch(repo);
	team.setState({ mode: "discover" }, ctx);
	team.ask(
		[
			`Populate Linear for this repository, following "Linear" in ${team.resource("skills", "discovery", "SKILL.md")}.`,
			"Propose one project and the open work found in the old task ledgers, plans and PRDs, then call team_project_populate once.",
			"It shows the human a preview and creates nothing until they confirm. Finished work is not imported.",
			`Once the tool reports the issues exist: record the project name under "linear.project" in ${PROFILE_PATH}; delete the old ledgers and the scripts that maintain them with git rm; fix any document that still points at them.`,
			"Then call team_discover_report again with the ledgers listed as migrated to the Linear project, and commit.",
			"If the human declines the preview, change nothing and say so.",
		].join("\n"),
		ctx,
	);
}

interface Readiness {
	problems: string[];
	notes: string[];
	changes: ReturnType<typeof parseNameStatus>;
}

async function readiness(team: Team, ctx: ExtensionCommandContext): Promise<Readiness & { repo: RepoContext }> {
	// The profile was written during this session, so read the repository again.
	const repo = (await team.loadRepo(ctx.cwd)) ?? (await team.requireRepo(ctx));
	const problems: string[] = [];
	const notes: string[] = [];
	const git = await repo.git.state();
	const state = repo.discover.read();
	const changes = parseNameStatus(await repo.git.nameStatus(repo.defaultRef));

	if (git?.branch !== ADOPT_BRANCH) problems.push(`Not on ${ADOPT_BRANCH}`);
	if (git && git.changed.length + git.untracked.length) problems.push(`${git.changed.length + git.untracked.length} uncommitted file(s); commit them or remove them`);
	if (!changes.length) problems.push(`No commits beyond ${repo.defaultRef}`);
	const profileChange = changes.find((c) => c.path === PROFILE_PATH || c.to === PROFILE_PATH);
	if (repo.profileState.errors.length) problems.push(`${PROFILE_PATH} is invalid: ${repo.profileState.errors.join("; ")}`);
	else if (!repo.profile) problems.push(`${PROFILE_PATH} has not been written`);
	else if (repo.profileState.source === "default-branch" && !profileChange) notes.push("The profile is unchanged from the default branch");
	if (repo.profile) {
		// The profile is only useful if what it points at is real.
		const tracked = await repo.git.trackedFiles();
		const missing = repo.profile.docs.filter((doc) => !tracked.includes(doc));
		if (missing.length) problems.push(`The profile lists documents that are not in the repository: ${missing.join(", ")}`);
		const unmatched = repo.profile.generated.filter((glob) => !tracked.some((file) => globToRegExp(glob).test(file)));
		if (unmatched.length) notes.push(`Generated-path patterns that match no tracked file (they should name checked-in generated files, not build output): ${unmatched.join(", ")}`);
	}
	if (!state.report) problems.push("No adoption report; the agent files it with team_discover_report");
	const unaccounted = unaccountedDeletions(changes, state.report);
	if (unaccounted.length) {
		problems.push(`Deleted without being listed as migrated or removed in the report: ${unaccounted.slice(0, 15).join(", ")}${unaccounted.length > 15 ? ` and ${unaccounted.length - 15} more` : ""}`);
	}
	if (!state.project) notes.push("No Linear project populated (/discover linear); the pull request will say so");
	return { problems, notes, changes, repo };
}

async function status(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const ready = await readiness(team, ctx);
	const count = (s: string) => ready.changes.filter((c) => c.status === s).length;
	team.report(
		[
			ready.problems.length ? `/discover: not ready for a pull request (${ready.problems.length} problem(s))` : "/discover: ready for /discover pr",
			...ready.problems.map((p) => `✗ ${p}`),
			...ready.notes.map((n) => `? ${n}`),
			`Changes on ${ADOPT_BRANCH}: ${count("A")} added, ${count("M")} changed, ${count("R")} moved, ${count("D")} removed`,
		].join("\n"),
	);
}

// The pull request is raised from the host, because the sandbox has no credentials.
async function pr(team: Team, ctx: ExtensionCommandContext): Promise<void> {
	const ready = await readiness(team, ctx);
	const { repo, changes } = ready;
	if (ready.problems.length) {
		team.report(["/discover pr: not ready", ...ready.problems.map((p) => `✗ ${p}`), ...ready.notes.map((n) => `? ${n}`)].join("\n"));
		return;
	}
	const profile = repo.profile;
	if (!profile) throw new TeamError(`${PROFILE_PATH} has not been written`);
	const existing = await repo.gh.prForBranch(ADOPT_BRANCH);
	if (repo.gh.lastError) throw new TeamError(`Could not query GitHub (${repo.gh.lastError}); nothing was pushed`);
	const open = existing?.state === "OPEN" ? existing : undefined;
	const body = redactSecrets(
		adoptionPrBody({ profileName: profile.name, changes, state: repo.discover.read(), verifyOffline: profile.verify.offline, invariants: profile.invariants.length, generated: profile.generated.length }),
	);
	const count = (s: string) => changes.filter((c) => c.status === s).length;
	const plan = `Push ${ADOPT_BRANCH} (${count("A")} added, ${count("M")} changed, ${count("R")} moved, ${count("D")} removed) to origin${open ? `; PR #${open.number} is already open` : " and open a pull request for review"}.`;
	if (ctx.hasUI && !(await ctx.ui.confirm("Raise the adoption pull request?", [plan, ...ready.notes].join("\n")))) {
		ctx.ui.notify("Nothing was pushed", "info");
		return;
	}
	const pushed = await repo.git.push(ADOPT_BRANCH);
	if (pushed.code !== 0) throw new TeamError(`git push failed: ${pushed.stderr.trim().split("\n").slice(-2).join(" ")}`);
	const out = [`Pushed ${ADOPT_BRANCH} to origin.`];
	if (open) out.push(`PR #${open.number}: ${open.url}`);
	else {
		const created = await repo.gh.createPr({ head: ADOPT_BRANCH, base: repo.defaultRef.replace(/^origin\//, ""), title: "Adopt the pi-team workflow", body, draft: false });
		out.push(created.url ? `Opened pull request: ${created.url}` : `The branch is pushed, but the pull request was not created (${created.error}). Open it by hand.`);
	}
	out.push(`The profile takes effect when the pull request merges into ${repo.defaultRef}.`);
	team.report(out.join("\n"));
}

interface ProposedIssue {
	source: string;
	title: string;
	description: string;
	state: "backlog" | "ready";
	dependsOn: string[];
}

function registerDiscoverTools(team: Team): void {
	team.pi.registerTool({
		name: "team_discover_report",
		label: "File adoption report",
		description:
			"During /discover: record what the adoption did with the repository's old harness, specifications and ledgers. Every deleted file must be covered, by path or by directory, as migrated (where its content now lives) or removed (why nothing replaces it). The report becomes the pull request description. Calling it again replaces the previous report.",
		parameters: Type.Object({
			summary: Type.String({ description: "Two or three sentences for the reviewer: what the repository had and what it has now" }),
			migrated: Type.Array(Type.Object({ from: Type.String({ description: "Old file or directory" }), to: Type.String({ description: "Where its content lives now: a path, the profile, or Linear" }) })),
			removed: Type.Array(Type.Object({ path: Type.String({ description: "Old file or directory deleted with no replacement" }), reason: Type.String() })),
			followUps: Type.Array(Type.String(), { description: "Things a person still has to decide or do" }),
		}) as TSchema,
		annotations: { readOnlyHint: false, destructiveHint: false },
		async execute(_id, params: DiscoverReport, _signal, _update, ctx) {
			const repo = await team.requireRepo(ctx);
			if (!params.summary.trim()) throw new TeamError("The report needs a summary");
			repo.discover.update({ report: params });
			const base = await repo.git.mergeBase(repo.defaultRef);
			// Includes work not committed yet, so gaps show before the commit.
			const pending = base ? parseNameStatus((await repo.git.run(["diff", "--name-status", "-M", base])) ?? "") : [];
			const unaccounted = unaccountedDeletions(pending, params);
			if (unaccounted.length) {
				return text(`Report saved, but these deleted files are not covered by it:\n${unaccounted.map((p) => `- ${p}`).join("\n")}\nAdd each to "migrated" or "removed" (a directory covers its files) and call team_discover_report again.`, true);
			}
			return text(`Report saved: ${params.migrated.length} migrated, ${params.removed.length} removed, ${params.followUps.length} follow-up(s). Every deletion is accounted for.`);
		},
	});

	team.pi.registerTool({
		name: "team_project_populate",
		label: "Populate Linear project",
		description:
			"During /discover: create (or reuse) one Linear project for this repository and fill it with the open work found in its old ledgers, plans and PRDs. Shows the human a preview and creates only after they confirm. Issues are matched by their `source`, so running it again never duplicates.",
		parameters: Type.Object({
			project: Type.Object({ name: Type.String(), description: Type.String({ description: "One or two sentences on the outcome this project tracks" }) }),
			issues: Type.Array(
				Type.Object({
					source: Type.String({ description: "Stable reference to where this work was recorded, e.g. tasks/T012.md or prd.md#billing" }),
					title: Type.String(),
					description: Type.String({ description: "Acceptance and context in the original's own terms (Markdown), including its previous status and owner if recorded" }),
					state: Type.Unsafe<"backlog" | "ready">({ type: "string", enum: ["backlog", "ready"], description: "ready only when acceptance is clear and nothing blocks it" }),
					dependsOn: Type.Array(Type.String(), { description: "Sources of issues in this call that must finish first" }),
				}),
			),
		}) as TSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_id, params: { project: { name: string; description: string }; issues: ProposedIssue[] }, _signal, _update, ctx) {
			const repo = (await team.loadRepo(ctx.cwd)) ?? (await team.requireRepo(ctx));
			const profile = repo.profile;
			if (!profile) return text(`Write a valid ${PROFILE_PATH} first; issues are labelled and tagged with the repository name.${repo.profileState.errors.length ? ` Problems: ${repo.profileState.errors.join("; ")}` : ""}`, true);

			const errors: string[] = [];
			const sources = new Set<string>();
			for (const issue of params.issues) {
				if (!/^[^`\n]+$/.test(issue.source.trim())) errors.push(`"${issue.source}" is not a usable source reference`);
				if (sources.has(issue.source)) errors.push(`Duplicate source ${issue.source}`);
				sources.add(issue.source);
				if (!issue.title.trim()) errors.push(`${issue.source} has no title`);
			}
			for (const issue of params.issues) {
				for (const dep of issue.dependsOn) if (!sources.has(dep) || dep === issue.source) errors.push(`${issue.source} depends on ${dep}, which is not another issue in this call`);
			}
			if (!params.project.name.trim()) errors.push("The project needs a name");
			if (errors.length) return text(`Proposal rejected:\n${errors.map((e) => `- ${e}`).join("\n")}`, true);

			const linearClient = team.linear();
			const teamKey = team.config.linear.teamKey;
			const linearTeam = await linearClient.team(teamKey);
			if (!linearTeam) throw new TeamError(`Linear team ${teamKey} not found (team.json linear.teamKey)`);
			const existingProject = await linearClient.project(params.project.name);
			const matches = params.issues.length
				? await linearClient.issues({ team: { key: { eq: teamKey } }, or: params.issues.map((i) => ({ description: { contains: i.source } })) }, 500)
				: Object.assign([] as IssueRef[], { more: false });
			const existing = new Map<string, IssueRef>();
			for (const found of matches) {
				const meta = parseMetadata(found.description);
				if (meta.source && meta.repo === profile.name && !existing.has(meta.source)) existing.set(meta.source, found);
			}
			const create = params.issues.filter((i) => !existing.has(i.source));
			const links = params.issues.flatMap((issue) =>
				[...new Set(issue.dependsOn)]
					.filter((dep) => {
						const blocked = existing.get(issue.source);
						const blocker = existing.get(dep);
						if (!blocked || !blocker) return true;
						return isOpen(blocked) && isOpen(blocker) && !blocked.openBlockers?.includes(blocker.identifier);
					})
					.map((dep) => ({ blocker: dep, blocked: issue.source })),
			);

			const preview = [
				`Linear team ${teamKey}, repository ${profile.name}`,
				existingProject ? `Reuse project "${existingProject.name}"` : `Create project "${params.project.name}": ${params.project.description}`,
				`Reuse ${params.issues.length - create.length} issue(s):`,
				...params.issues.filter((i) => existing.has(i.source)).map((i) => `- ${i.source} → ${existing.get(i.source)!.identifier}`),
				`Create ${create.length} issue(s):`,
				...create.map((i) => `- [${i.state}] ${i.title} (${i.source})`),
				`Link ${links.length} dependencies`,
				...(matches.more ? ["Warning: more issues mention these sources than were fetched; check Linear for duplicates before confirming."] : []),
			].join("\n");
			// What earlier runs of this adoption created stays marked as created, so the pull request describes the whole adoption.
			const before = repo.discover.read().project;
			const createdEarlier = (source: string) => before?.issues.some((i) => i.source === source && i.created) ?? false;
			if (existingProject && create.length === 0 && links.length === 0) {
				repo.discover.update({
					project: {
						name: existingProject.name,
						url: existingProject.url,
						created: before?.created ?? false,
						issues: params.issues.map((i) => ({ source: i.source, identifier: existing.get(i.source)!.identifier, url: existing.get(i.source)!.url, created: createdEarlier(i.source) })),
					},
				});
				return text(`${preview}\n\nNothing to create.`);
			}
			if (!ctx.hasUI) return text(`${preview}\n\nPreview only: confirmation needs an interactive session.`);
			if (!(await ctx.ui.confirm(`Create ${existingProject ? "" : "a Linear project and "}${create.length} issue(s)?`, preview))) {
				return text(`${preview}\n\nThe human declined; nothing was created.`);
			}

			const stateIds = { backlog: await team.stateId(teamKey, "backlog"), ready: await team.stateId(teamKey, "ready") };
			const label = await linearClient.labelId(profile.linear.label, linearTeam.id);
			const ids = new Map<string, { id: string; identifier: string; url: string; created: boolean }>(
				[...existing].map(([source, issue]) => [source, { id: issue.id, identifier: issue.identifier, url: issue.url, created: false }]),
			);
			let project = existingProject;
			const record = () => {
				if (!project) return;
				repo.discover.update({
					project: {
						name: project.name,
						url: project.url,
						created: !existingProject || (before?.created ?? false),
						issues: params.issues
							.filter((i) => ids.has(i.source))
							.map((i) => ({ source: i.source, identifier: ids.get(i.source)!.identifier, url: ids.get(i.source)!.url, created: ids.get(i.source)!.created || createdEarlier(i.source) })),
					},
				});
			};
			try {
				project ??= await linearClient.createProject({ name: params.project.name, description: params.project.description, teamIds: [linearTeam.id] });
				for (const issue of create) {
					const description = redactSecrets([issue.description.trim(), "", formatMetadata({ repo: profile.name, source: issue.source, requirements: [] })].join("\n"));
					const made = await linearClient.createIssue({
						teamId: linearTeam.id,
						title: issue.title,
						description,
						labelIds: label ? [label] : undefined,
						projectId: project.id,
						stateId: issue.dependsOn.length ? stateIds.backlog : stateIds[issue.state],
					});
					ids.set(issue.source, { ...made, created: true });
				}
				for (const link of links) await linearClient.createBlocksRelation(ids.get(link.blocker)!.id, ids.get(link.blocked)!.id);
			} catch (error) {
				record();
				const uncertain = error instanceof LinearError && error.uncertain;
				return text(
					[
						`Stopped: ${errorText(error)}${uncertain ? " (the last write may or may not have been applied)" : ""}.`,
						`Created before stopping: ${[...ids.values()].filter((i) => i.created).map((i) => i.identifier).join(", ") || "none"}.`,
						"Call team_project_populate again with the same sources: existing issues are reused, not duplicated.",
					].join("\n"),
					true,
				);
			}
			record();
			const made = [...ids.values()].filter((i) => i.created);
			return text(
				[
					preview,
					"",
					`Project: ${project.url}`,
					`Created: ${made.map((i) => i.identifier).join(", ") || "no new issues"}. Linked ${links.length} dependencies.`,
					label ? "" : `No "${profile.linear.label}" label exists in Linear, so the issues are unlabelled; create it and add it.`,
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});
}
