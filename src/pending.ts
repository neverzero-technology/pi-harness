import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One pending checkpoint per issue, kept in the shared git dir so every worktree of the repo sees it.
// It is local recovery data, explicitly not shared progress.

export interface PendingCheckpoint {
	id: string;
	issue: string;
	body: string;
	createdAt: string;
	error: string;
	uncertain: boolean;
}

export class PendingStore {
	private readonly gitCommonDir: string;

	constructor(gitCommonDir: string) {
		this.gitCommonDir = gitCommonDir;
	}

	private dir(): string {
		return join(this.gitCommonDir, "pi-team", "pending");
	}

	private file(issue: string): string {
		return join(this.dir(), `${issue}.json`);
	}

	get(issue: string): PendingCheckpoint | undefined {
		try {
			return JSON.parse(readFileSync(this.file(issue), "utf8")) as PendingCheckpoint;
		} catch {
			return undefined;
		}
	}

	put(pending: PendingCheckpoint): void {
		mkdirSync(this.dir(), { recursive: true });
		writeFileSync(this.file(pending.issue), `${JSON.stringify(pending, null, 2)}\n`);
	}

	clear(issue: string): void {
		rmSync(this.file(issue), { force: true });
	}

	list(): PendingCheckpoint[] {
		try {
			return readdirSync(this.dir())
				.filter((f) => f.endsWith(".json"))
				.map((f) => this.get(f.slice(0, -5)))
				.filter((p): p is PendingCheckpoint => p !== undefined);
		} catch {
			return [];
		}
	}
}

export interface ReviewRecord {
	issue: string;
	commit: string;
	verdict: string;
	at: string;
}

// The latest agent review per issue, so /work finish can check it from any later session or worktree.
export class ReviewStore {
	private readonly gitCommonDir: string;

	constructor(gitCommonDir: string) {
		this.gitCommonDir = gitCommonDir;
	}

	private file(issue: string): string {
		return join(this.gitCommonDir, "pi-team", "reviews", `${issue}.json`);
	}

	get(issue: string): ReviewRecord | undefined {
		try {
			return JSON.parse(readFileSync(this.file(issue), "utf8")) as ReviewRecord;
		} catch {
			return undefined;
		}
	}

	put(record: ReviewRecord): void {
		mkdirSync(join(this.gitCommonDir, "pi-team", "reviews"), { recursive: true });
		writeFileSync(this.file(record.issue), `${JSON.stringify(record, null, 2)}\n`);
	}
}

// The verdict is the first line that *is* a verdict (allowing Markdown decoration or a "Verdict:" label),
// so "not yet READY FOR HUMAN REVIEW" in prose is never read as approval.
export function reviewVerdict(output: string): string {
	for (const line of output.split("\n")) {
		const text = line.replace(/[*_`#>]/g, "").replace(/^\s*verdict\s*[:\-–—]\s*/i, "").trim();
		const match = /^(READY FOR HUMAN REVIEW|CHANGES NEEDED|CANNOT ASSESS)\b/.exec(text);
		if (match) return match[1];
	}
	return "UNKNOWN";
}
