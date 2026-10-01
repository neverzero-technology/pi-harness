import type { ParsedCheckpoint } from "./checkpoint.ts";
import type { Profile } from "./config.ts";
import type { Issue } from "./linear.ts";
import { isOpen } from "./linear.ts";
import { parseMetadata, stripMetadata } from "./metadata.ts";

// What a session needs to work one issue: precise acceptance, spec revision, constraints, verification, last checkpoint.
export function issueBriefing(issue: Issue, profile: Profile | undefined, latest: ParsedCheckpoint | undefined): string {
	const meta = parseMetadata(issue.description);
	const lines = [
		`# ${issue.identifier}: ${issue.title}`,
		`${issue.url} · ${issue.state.name} · ${issue.assignee?.name ?? "unassigned"}`,
		"",
		"## Acceptance",
		stripMetadata(issue.description) || "(none written; ask the human before implementing)",
		"",
	];
	if (meta.spec) {
		lines.push(
			"## Specification",
			`${meta.specRepo ? `${meta.specRepo}:` : ""}${meta.spec}${meta.specCommit ? ` at ${meta.specCommit}` : ""}; requirements ${meta.requirements.join(", ") || "(not listed)"}`,
			"",
		);
	}
	const blockers = issue.blockers.filter(isOpen);
	if (blockers.length) {
		lines.push("## Open prerequisites", ...blockers.map((b) => `- ${b.identifier} ${b.title} (${b.state.name})`), "");
	}
	if (profile) {
		lines.push(
			`## ${profile.name} constraints`,
			...profile.invariants.map((i) => `- ${i}`),
			"",
			`Read as needed: ${profile.docs.join(", ")}`,
			"",
			"## Verification",
			`- Offline gate: \`${profile.verify.offline}\``,
			...(profile.verify.selected ? [`- Selected: \`${profile.verify.selected}\``] : []),
			...(profile.verify.full ? [`- Full: \`${profile.verify.full}\``] : []),
			...profile.verify.notes.map((n) => `- ${n}`),
			"",
		);
	}
	if (latest) lines.push("## Latest checkpoint", latest.body, "");
	lines.push(
		"## Working rules",
		"- Implement only this issue's acceptance. Report scope changes; do not absorb them.",
		"- Record a checkpoint with team_checkpoint after a meaningful slice, on a material blocker, and before stopping or handing off.",
		"- Report checks exactly as run: command, pass/fail/skipped/unavailable, and local/simulated/live/ci scope.",
		"- You cannot push from the sandbox. When there are commits worth publishing, ask the human to run /work push (pushes the branch and opens a draft PR).",
		"- Run /review before asking for human review; /work finish reports what still stands between this issue and done.",
	);
	return lines.join("\n");
}
