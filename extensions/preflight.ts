import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTeam from "./team.ts";

// Used only by the launcher's --help probe. The marker appears only after the
// full factory succeeds under Pi's own loader and host-provided peer imports.
export default function preflight(pi: ExtensionAPI): void {
	piTeam(pi);
	pi.registerFlag("team-preflight", { type: "boolean", description: "Harness loaded successfully" });
}
