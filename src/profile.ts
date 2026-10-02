import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./git.ts";

// Everything the workflow needs to know about one repository lives in that repository, in this file.
// The package itself is repository-agnostic. /discover writes the first version.
export const PROFILE_DIR = ".pi-team";
export const PROFILE_PATH = `${PROFILE_DIR}/profile.json`;

export interface ReleasePin {
	file: string;
	producer: string;
	versionField: string;
	commitField: string;
}

export interface Profile {
	name: string;
	defaultBranch?: string;
	docs: string[];
	verify: { offline: string; full?: string; selected?: string; notes: string[] };
	generated: string[];
	invariants: string[];
	pins: ReleasePin[];
	consumers: string[];
	linear: { label: string; project?: string };
}

export interface LoadedProfile {
	profile: Profile | undefined;
	// The default branch copy rules once it exists, so a profile only changes through a merged pull request.
	source: "default-branch" | "working-tree" | "none";
	errors: string[];
	// True when the working tree holds a profile that differs from the one in force.
	unmerged: boolean;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseProfile(text: string): { profile?: Profile; errors: string[] } {
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { errors: [`${PROFILE_PATH} is not valid JSON: ${(error as Error).message}`] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${PROFILE_PATH} must be a JSON object`] };
	const errors: string[] = [];
	const list = (key: string): string[] => {
		if (raw[key] === undefined) return [];
		if (isStringList(raw[key])) return raw[key];
		errors.push(`"${key}" must be a list of strings`);
		return [];
	};
	if (!isString(raw.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.name)) {
		errors.push(`"name" is required: letters, digits, ".", "_" and "-" (it names the repository in issues and its repo:<name> label)`);
	}
	const verify = raw.verify ?? {};
	if (!isString(verify.offline)) errors.push(`"verify.offline" is required: the command that checks a change without external services`);
	for (const key of ["full", "selected"]) {
		if (verify[key] !== undefined && !isString(verify[key])) errors.push(`"verify.${key}" must be a command string`);
	}
	if (verify.notes !== undefined && !isStringList(verify.notes)) errors.push(`"verify.notes" must be a list of strings`);
	const pins: ReleasePin[] = [];
	for (const [i, pin] of (Array.isArray(raw.pins) ? raw.pins : raw.pins === undefined ? [] : [null]).entries()) {
		if (pin && isString(pin.file) && isString(pin.producer)) {
			pins.push({ file: pin.file, producer: pin.producer, versionField: isString(pin.versionField) ? pin.versionField : "version", commitField: isString(pin.commitField) ? pin.commitField : "commit" });
		} else {
			errors.push(`"pins[${i}]" needs "file" and "producer"`);
		}
	}
	if (raw.defaultBranch !== undefined && !isString(raw.defaultBranch)) errors.push(`"defaultBranch" must be a branch name`);
	const linear = raw.linear ?? {};
	// An empty string means "not set yet": the project is filled in after /discover linear.
	const optional = (value: unknown, what: string): string | undefined => {
		if (value === undefined || value === null || value === "") return undefined;
		if (isString(value)) return value;
		errors.push(`${what} must be a non-empty string`);
		return undefined;
	};
	const label = optional(linear.label, `"linear.label"`);
	const project = optional(linear.project, `"linear.project"`);
	const profile: Profile = {
		name: String(raw.name ?? ""),
		defaultBranch: raw.defaultBranch,
		docs: list("docs"),
		verify: { offline: String(verify.offline ?? ""), full: verify.full, selected: verify.selected, notes: isStringList(verify.notes) ? verify.notes : [] },
		generated: list("generated"),
		invariants: list("invariants"),
		pins,
		consumers: list("consumers"),
		linear: { label: label ?? `repo:${raw.name}`, project },
	};
	return errors.length ? { errors } : { profile, errors };
}

export async function loadProfile(git: Git, root: string, defaultRef: string): Promise<LoadedProfile> {
	const merged = await git.show(defaultRef, PROFILE_PATH);
	const file = join(root, PROFILE_PATH);
	const local = existsSync(file) ? readFileSync(file, "utf8") : undefined;
	if (merged !== undefined) {
		const parsed = parseProfile(merged);
		return { profile: parsed.profile, source: "default-branch", errors: parsed.errors, unmerged: local !== undefined && local.trim() !== merged.trim() };
	}
	if (local !== undefined) {
		const parsed = parseProfile(local);
		return { profile: parsed.profile, source: "working-tree", errors: parsed.errors, unmerged: true };
	}
	return { profile: undefined, source: "none", errors: [], unmerged: false };
}

// The shape /discover asks the agent to produce, with the meaning of each field.
export const PROFILE_GUIDE = `{
  "name": "<repository name; also used as the repo:<name> Linear label>",
  "docs": ["<2-6 authoritative documents an agent should read first, most general first>"],
  "verify": {
    "offline": "<the command that verifies a change with no external services>",
    "selected": "<optional: how to run only the affected checks>",
    "full": "<optional: the complete gate>",
    "notes": ["<what each gate needs, and which results are local, simulated, CI or live evidence>"]
  },
  "generated": ["<globs of checked-in files that a generator produces and nobody edits by hand; [] if there are none>"],
  "invariants": ["<4-10 one-line rules a change must not break, taken from the repository's own documents>"],
  "pins": [{ "file": "<lock file>", "producer": "<repository whose release is pinned>", "versionField": "version", "commitField": "commit" }],
  "consumers": ["<repositories that pin releases of this one>"],
  "linear": { "label": "repo:<name>" }
}
Omit "pins" and "consumers" when there are none. "linear.project" is added later, by /discover linear.`;
