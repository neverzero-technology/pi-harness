import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface TeamConfig {
	host: { piVersion: string };
	model: { id: string; thinking: string; reviewThinking: string };
	linear: {
		teamName: string;
		teamKey: string; // the issue prefix, e.g. NEV in NEV-123
		states: Record<LogicalState, string>;
		blockedLabel: string;
	};
	git: { branchPrefix: string; worktreeDir: string };
	launcher: { contextFiles: boolean };
	specs: { changesDir: string; capabilitiesDir: string; warnWords: number; warnRequirements: number };
}

export type LogicalState = "backlog" | "ready" | "inProgress" | "inReview" | "done" | "canceled";

// PI_TEAM_CONFIG points at another team.json; the test suites use it so they do not depend on the team's own settings.
export function teamConfigPath(root = PACKAGE_ROOT): string {
	return process.env.PI_TEAM_CONFIG || join(root, "team.json");
}

export function loadTeamConfig(root = PACKAGE_ROOT): TeamConfig {
	return JSON.parse(readFileSync(teamConfigPath(root), "utf8")) as TeamConfig;
}

export function readPackageVersion(root = PACKAGE_ROOT): string {
	return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

// The last path segment of an origin URL, e.g. "acme-api" for git@github.com:acme/acme-api.git.
export function repoNameFromOrigin(url: string | undefined): string | undefined {
	const name = url?.trim().replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
	return name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : undefined;
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
