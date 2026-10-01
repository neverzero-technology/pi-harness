import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./git.ts";

// A change spec is approved when it is merged to the default branch, which means a different human reviewed the PR.
// Planning stamps that merged revision on every issue.

export interface Approval {
	approved: boolean;
	commit?: string;
	detail: string;
}

export async function specApproval(git: Git, root: string, path: string, defaultRef: string): Promise<Approval> {
	const local = (await git.run(["status", "--porcelain=v1", "--", path])) ?? "";
	if (local.trim()) return { approved: false, detail: `${path} has uncommitted changes` };
	const commit = await git.lastCommitTouching(path, defaultRef);
	if (!commit) {
		return { approved: false, detail: `${path} is not on ${defaultRef}; merge the spec PR (reviewed by another person) to approve it` };
	}
	const merged = await git.show(defaultRef, path);
	if (merged === undefined) return { approved: false, detail: `${path} no longer exists on ${defaultRef}` };
	let working: string | undefined;
	try {
		working = readFileSync(join(root, path), "utf8");
	} catch {
		working = undefined;
	}
	if (working === undefined || merged.trimEnd() !== working.trimEnd()) {
		return { approved: false, commit, detail: `Local ${path} differs from ${defaultRef}; plan from the merged revision` };
	}
	return { approved: true, commit, detail: `Approved revision ${commit.slice(0, 12)} on ${defaultRef}` };
}
