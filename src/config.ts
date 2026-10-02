import { readFileSync } from "node:fs";
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

export function loadTeamConfig(root = PACKAGE_ROOT): TeamConfig {
	return JSON.parse(readFileSync(join(root, "team.json"), "utf8")) as TeamConfig;
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
