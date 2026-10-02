import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { specApproval } from "../approval.ts";
import { asList, parseFrontmatter } from "../frontmatter.ts";
import { readPin } from "../pin.ts";
import { errorText, type RepoContext, type Team, TeamError } from "../runtime.ts";
import { formatLint, type LintOptions, lintSpecFile, repositoryFilePath } from "../spec.ts";

export function lintOptions(team: Team, repo: RepoContext): LintOptions {
	const { capabilitiesDir, warnWords, warnRequirements } = team.config.specs;
	return { repoRoot: repo.root, capabilitiesDir, warnWords, warnRequirements };
}

export function specPath(repo: RepoContext, arg: string): string | undefined {
	if (!arg) return undefined;
	const absolute = isAbsolute(arg) ? arg : join(repo.root, arg);
	const file = repositoryFilePath(absolute, repo.root);
	return file ? relative(realpathSync(repo.root), file) : undefined;
}

function changeSpecs(team: Team, repo: RepoContext): string[] {
	const dir = join(repo.root, team.config.specs.changesDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(team.config.specs.changesDir, f));
}

function wrap(team: Team, name: string, run: (arg: string, ctx: ExtensionCommandContext) => Promise<void>) {
	return async (args: string, ctx: ExtensionCommandContext) => {
		try {
			await run(args.trim(), ctx);
		} catch (error) {
			ctx.ui.notify(`/${name}: ${errorText(error)}`, error instanceof TeamError ? "warning" : "error");
		}
	};
}

function target(team: Team, repo: RepoContext, arg: string): string {
	const path = specPath(repo, arg);
	if (path) return `the change specification \`${path}\``;
	const key = team.issueKeyFrom(arg);
	if (key) return `Linear issue ${key} (read it with team_issue_read)`;
	throw new TeamError("Name a spec path or an issue key");
}

export function registerSpec(team: Team): void {
	const skill = (name: string) => team.resource("skills", name, "SKILL.md");

	team.pi.registerCommand("spec", {
		description: "Change specifications: draft <issue|idea> | lint [path] | plan <path>",
		getArgumentCompletions: (prefix) =>
			["draft", "lint", "plan"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: wrap(team, "spec", async (args, ctx) => {
			const [sub, ...rest] = args.split(/\s+/);
			const arg = rest.join(" ").trim();
			const repo = await team.requireRepo(ctx);
			if (sub === "lint") {
				const paths = arg ? [specPath(repo, arg)] : changeSpecs(team, repo);
				if (paths.some((p) => !p)) throw new TeamError(`No such file: ${arg}`);
				if (!paths.length) {
					ctx.ui.notify(`No specs in ${team.config.specs.changesDir}/`, "info");
					return;
				}
				team.report(paths.map((p) => formatLint(lintSpecFile(join(repo.root, p!), lintOptions(team, repo)), p!)).join("\n\n"));
				return;
			}
			if (sub === "draft") {
				if (!arg) throw new TeamError("Usage: /spec draft <issue key or short description>");
				const key = team.issueKeyFrom(arg);
				team.setState({ mode: "spec" }, ctx);
				team.ask(
					[
						`Follow the specification skill at ${skill("specification")}.`,
						key ? `Source: Linear issue ${key}. Read it with team_issue_read.` : `Source idea from the human: ${arg}`,
						`Repository: ${repo.profile?.name ?? "unprofiled"}. Authoritative documents: ${repo.profile?.docs.join(", ") ?? "find them"}.`,
						`Template: ${team.resource("templates", "change-specification.md")}. Write to ${team.config.specs.changesDir}/<id>.md.`,
						"Decide proportionate depth first and say which path applies before writing anything.",
						"Spec mode is on: edits outside docs/ are blocked. Check your draft with team_spec_lint and finish by listing the questions for /grill.",
					].join("\n"),
					ctx,
				);
				return;
			}
			if (sub === "plan") {
				const path = specPath(repo, arg);
				if (!path) throw new TeamError("Usage: /spec plan <path to change spec>");
				const lint = lintSpecFile(join(repo.root, path), lintOptions(team, repo));
				if (lint.errors.length || lint.spec.blocking.length) {
					team.report(`Cannot plan until lint errors and blocking questions are resolved.\n\n${formatLint(lint, path)}`);
					return;
				}
				await repo.git.fetch("origin", repo.defaultRef.replace(/^origin\//, ""));
				const approval = await specApproval(repo.git, repo.root, path, repo.defaultRef);
				team.setState({ mode: "spec" }, ctx);
				team.ask(
					[
						`Plan Linear issues for ${path} following "Planning slices" in ${skill("specification")}.`,
						approval.approved
							? `${approval.detail}.`
							: `Not approved: ${approval.detail}. team_plan_slices will only preview; nothing will be created.`,
						"Search existing issues and open PRs first (team_issue_search) so equivalent work is reused, not duplicated.",
						`Then call team_plan_slices with spec "${path}" and the proposed slices. The human confirms the preview before anything is created.`,
					].join("\n"),
					ctx,
				);
				return;
			}
			throw new TeamError("Usage: /spec draft <issue|idea> | lint [path] | plan <path>");
		}),
	});

	team.pi.registerCommand("grill", {
		description: "Interview the human about a spec or epic, one question at a time",
		handler: wrap(team, "grill", async (arg, ctx) => {
			const repo = await team.requireRepo(ctx);
			team.setState({ mode: "spec" }, ctx);
			team.ask(
				[
					`Follow the requirements-interview skill at ${skill("requirements-interview")} for ${target(team, repo, arg)}.`,
					"Ask exactly one question per message and wait for the answer. No implementation.",
				].join("\n"),
				ctx,
			);
		}),
	});

	team.pi.registerCommand("align", {
		description: "Check a spec or issue against architecture, source and producer/consumer contracts",
		handler: wrap(team, "align", async (arg, ctx) => {
			const repo = await team.requireRepo(ctx);
			const subject = target(team, repo, arg);
			const facts: string[] = [];
			const path = specPath(repo, arg);
			if (path) {
				facts.push(formatLint(lintSpecFile(join(repo.root, path), lintOptions(team, repo)), path));
				const mine = asList(parseFrontmatter(readFileSync(join(repo.root, path), "utf8")).frontmatter?.capabilities);
				const overlapping = changeSpecs(team, repo)
					.filter((p) => p !== path)
					.filter((p) => {
						const caps = asList(parseFrontmatter(readFileSync(join(repo.root, p), "utf8")).frontmatter?.capabilities);
						return caps.some((c) => mine.includes(c));
					});
				if (overlapping.length) facts.push(`Other change specs touching the same capabilities: ${overlapping.join(", ")}`);
			}
			const profile = repo.profile;
			for (const declared of profile?.pins ?? []) {
				const pin = readPin(repo.root, declared);
				facts.push(
					pin
						? `This repo consumes ${pin.producer} ${pin.version ?? "?"} (tag ${pin.tag ?? "?"}, commit ${pin.commit ?? "?"}) per ${pin.file}. Compare producer features against that release, not the producer's latest checkout.`
						: `Pin file ${declared.file} not readable.`,
				);
			}
			if (profile?.consumers.length) {
				facts.push(
					`Consumers pin releases of this repo: ${profile.consumers.join(", ")}. A producer change reaches them only through a published release plus a pin-update issue; make that a dependency.`,
				);
			}
			team.setState({ mode: "review" }, ctx);
			team.ask(
				[
					`Follow the alignment skill at ${skill("alignment")} for ${subject}.`,
					`Repository: ${profile?.name ?? "unprofiled"}. Authoritative documents: ${profile?.docs.join(", ") ?? "find them"}.`,
					"Deterministic facts gathered by the extension:",
					...facts.map((f) => `\n${f}`),
					"",
					"Review mode is on: this is a read-only report.",
				].join("\n"),
				ctx,
			);
		}),
	});
}
