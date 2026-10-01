import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSandbox } from "../src/sandbox.ts";

export default function reviewerSandbox(pi: ExtensionAPI): void {
	registerSandbox(pi, { readOnly: true });
	pi.registerFlag("team-reviewer-sandbox", { type: "boolean", description: "Read-only reviewer sandbox loaded" });
}
