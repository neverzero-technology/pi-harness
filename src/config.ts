import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface TeamConfig {
	host: { piVersion: string };
	model: { id: string; thinking: string; reviewThinking: string };
	linear: {
		teamKey: string;
		states: Record<LogicalState, string>;
		blockedLabel: string;
	};
	git: { branchPrefix: string; worktreeDir: string };
	launcher: { contextFiles: boolean };
	specs: { changesDir: string; capabilitiesDir: string; warnWords: number; warnRequirements: number };
}

export type LogicalState = "backlog" | "ready" | "inProgress" | "inReview" | "done" | "canceled";

export interface ReleasePin {
	file: string;
	producer: string;
	versionField: string;
	commitField: string;
}

export interface Profile {
	name: string;
	origins: string[];
	linearLabel: string;
	defaultBranch: string;
	docs: string[];
	verify: { offline: string; full?: string; selected?: string; notes: string[] };
	generated: string[];
	invariants: string[];
	pin?: ReleasePin;
	legacy: string[];
}

export function loadTeamConfig(root = PACKAGE_ROOT): TeamConfig {
	return JSON.parse(readFileSync(join(root, "team.json"), "utf8")) as TeamConfig;
}

export function loadProfiles(root = PACKAGE_ROOT): Profile[] {
	const dir = join(root, "profiles");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Profile);
}

export function readPackageVersion(root = PACKAGE_ROOT): string {
	return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

// https://github.com/org/repo.git, git@github.com:org/repo and ssh://git@github.com/org/repo all become github.com/org/repo.
export function normalizeOrigin(url: string): string {
	let s = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
	s = s.replace(/^[a-z+]+:\/\//i, "");
	s = s.replace(/^[^@/]+@/, "");
	s = s.replace(/^([^/:]+):(?!\d)/, "$1/");
	return s.toLowerCase();
}

export function profileForOrigin(profiles: Profile[], origin: string | undefined): Profile | undefined {
	if (!origin) return undefined;
	const normalized = normalizeOrigin(origin);
	return profiles.find((p) => p.origins.some((o) => normalizeOrigin(o) === normalized));
}

export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") i++;
				re += ".*";
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): string | undefined {
	return globs.find((g) => globToRegExp(g).test(path));
}
