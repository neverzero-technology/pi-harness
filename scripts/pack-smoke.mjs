#!/usr/bin/env node
// Smoke-test the packed tarball, not the source checkout: required files ship, tests do not,
// the launcher resolves its own resources, and (with PI_TEAM_SMOKE_PI=1) the real Pi host loads
// the extension without any node_modules of its own.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-team-pack-")));
const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" }));
execFileSync("tar", ["-xzf", join(work, filename), "-C", work]);
const pkg = join(work, "package");

const required = [
	"package.json",
	"team.json",
	"bin/pi-team.mjs",
	"extensions/team.ts",
	"extensions/reviewer.ts",
	"extensions/preflight.ts",
	"src/PI-LICENSE.txt",
	"src/sandbox.ts",
	"src/runtime.ts",
	"skills/specification/SKILL.md",
	"skills/delivery/SKILL.md",
	"profiles/foundations-idp.json",
	"templates/change-specification.md",
	"review/independent-review.md",
];
const missing = required.filter((f) => !existsSync(join(pkg, f)));
if (missing.length) throw new Error(`Tarball is missing: ${missing.join(", ")}`);
for (const f of ["tests", "node_modules", "scripts"]) if (existsSync(join(pkg, f))) throw new Error(`Tarball should not contain ${f}/`);

const dry = JSON.parse(
	execFileSync(process.execPath, [join(pkg, "bin/pi-team.mjs")], { encoding: "utf8", env: { ...process.env, PI_TEAM_DRY_RUN: "1" } }),
);
if (!dry.args.includes(join(pkg, "extensions", "team.ts"))) throw new Error("Launcher does not point at the packed extension");
console.log(`ok  ${filename}: ${required.length} required files present; launcher resolves packed resources`);

if (process.env.PI_TEAM_SMOKE_PI === "1") {
	// Production runtime dependencies must be installed in the packed package,
	// rather than accidentally resolved from the development checkout.
	execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: pkg, stdio: "pipe" });
	const repo = join(work, "repo");
	mkdirSync(join(repo, "docs/changes"), { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "https://github.com/neverzero-technology/foundations.git"], { cwd: repo });
	writeFileSync(join(repo, "docs/changes/x.md"), "---\nid: x\nlinear: ENG-1\n---\n# X\n");
	const out = execFileSync(process.execPath, [join(pkg, "bin/pi-team.mjs"), "--mode", "json", "-p", "--no-session", "--offline", "/spec lint"], {
		cwd: repo,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (!/FAIL {2}docs\/changes\/x\.md/.test(out)) throw new Error(`Real Pi did not run /spec lint from the packed extension:\n${out.slice(0, 2000)}`);
	console.log("ok  real Pi loaded the packed extension (host-provided typebox) and ran /spec lint");
	const reviewer = execFileSync(dry.pi, ["--help", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", join(pkg, "extensions", "reviewer.ts")], { cwd: repo, encoding: "utf8", timeout: 30_000 });
	if (!reviewer.includes("--team-reviewer-sandbox")) throw new Error("Real Pi did not load the packed reviewer sandbox");
	console.log("ok  real Pi loaded the packed read-only reviewer sandbox");
}
