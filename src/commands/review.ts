import type { Team } from "../runtime.ts";
import { errorText, TeamError } from "../runtime.ts";
import { latestCheckpoint, latestChecks } from "../checkpoint.ts";
import { parseMetadata, stripMetadata } from "../metadata.ts";
import { reviewVerdict } from "../pending.ts";
import { buildReviewPacket, MAX_DIFF_BYTES, runReviewer } from "../review.ts";

export function registerReview(team: Team): void {
	team.registerCommand("review", {
		description: "Fresh-context, read-only agent review of the current change against its acceptance",
		handler: async (args, ctx) => {
			try {
				const repo = await team.requireRepo(ctx);
				const key = await team.resolveIssueKey(args.trim() || undefined, ctx);
				const issue = await team.requireIssue(key);
				const git = await repo.git.state();
				if (!git?.head) throw new TeamError("No commit to review");
				await repo.git.fetch("origin", repo.defaultRef.replace(/^origin\//, ""));
				const base = await repo.git.mergeBase(repo.defaultRef);
				if (!base) throw new TeamError(`No merge base with ${repo.defaultRef}`);
				const diff = await repo.git.diff(base, MAX_DIFF_BYTES);
				const untracked = git.untracked.length ? `\n\nUntracked files (not in the diff; read them directly): ${git.untracked.join(", ")}` : "";
				const latest = latestCheckpoint(issue.comments);
				const packet = buildReviewPacket({
					issue: issue.identifier,
					title: issue.title,
					url: issue.url,
					acceptance: stripMetadata(issue.description),
					spec: parseMetadata(issue.description).spec,
					profile: repo.profile,
					head: git.head,
					base,
					dirtyFiles: [...git.changed, ...git.untracked],
					checkpoint: latest?.body,
					checks: latestChecks(issue.comments),
					diff: diff.text,
					diffTruncated: diff.truncated,
					diffStat: diff.stat + untracked,
				});

				const changed = new Set([...(await repo.git.changedFiles(base)), ...git.untracked]);
				const overlaps = (await repo.gh.openPrFiles())
					.filter((pr) => pr.headRefName !== git.branch)
					.map((pr) => ({ pr, files: pr.files.filter((f) => changed.has(f)) }))
					.filter((o) => o.files.length);
				const dirty = git.changed.length + git.untracked.length > 0;
				if (ctx.hasUI) ctx.ui.setStatus("pi-team-review", `reviewing ${key} @ ${git.head.slice(0, 8)}…`);
				const run = await runReviewer({
					cwd: repo.root,
					packet,
					systemPrompt: team.resource("review", "independent-review.md"),
					model: team.config.model.id,
					thinking: team.config.model.reviewThinking,
					signal: ctx.signal,
				});
				if (ctx.hasUI) ctx.ui.setStatus("pi-team-review", undefined);

				if (run.exitCode !== 0 || !run.output.trim()) {
					team.report(`Review failed (exit ${run.exitCode}); no review is recorded.\n${run.stderr.trim()}`);
					return;
				}
				const verdict = reviewVerdict(run.output);
				if (!dirty) repo.reviews.put({ issue: key, commit: git.head, verdict, at: new Date().toISOString() });
				team.pi.sendMessage(
					{
						customType: "pi-team-review",
						content: [
							`Independent agent review of ${key} @ ${git.head.slice(0, 12)}${dirty ? " plus uncommitted changes" : ""} (${run.model ?? team.config.model.id}, read-only tools).`,
							dirty ? "The tree was dirty, so this review does not count for /work finish; commit and rerun." : "",
							"It supports, but does not replace, review by another person.",
							...overlaps.map((o) => `Overlapping open PR #${o.pr.number} (${o.pr.headRefName}): ${o.files.join(", ")}`),
							"",
							run.output,
						]
							.filter((l, i) => l !== "" || i > 2)
							.join("\n"),
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.setStatus("pi-team-review", undefined);
				ctx.ui.notify(`/review: ${errorText(error)}`, error instanceof TeamError ? "warning" : "error");
			}
		},
	});
}
