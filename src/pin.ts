import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleasePin } from "./config.ts";

export interface PinnedRelease {
	file: string;
	producer: string;
	version?: string;
	commit?: string;
	tag?: string;
}

// Reads the scalar fields of the `release:` block. The lock file stays the only version registry.
export function readPin(root: string, pin: ReleasePin): PinnedRelease | undefined {
	let text: string;
	try {
		text = readFileSync(join(root, pin.file), "utf8");
	} catch {
		return undefined;
	}
	const block = /^release:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? text;
	const field = (name: string) => new RegExp(`^\\s+${name}:\\s*["']?([^"'\\s#]+)`, "m").exec(block)?.[1];
	return {
		file: pin.file,
		producer: pin.producer,
		version: field(pin.versionField),
		commit: field(pin.commitField),
		tag: field("tag"),
	};
}
