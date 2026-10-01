import assert from "node:assert/strict";
import { test } from "node:test";
import { guardToolCall, type GuardInput, shellSegments } from "../src/modes.ts";

const base: GuardInput = {
	mode: "implement",
	toolName: "write",
	input: { path: "src/a.ts" },
	cwd: "/repo",
	repoRoot: "/repo",
	generated: ["templates/generated/**", "platform/kcc/*operator*"],
	specDirs: ["docs"],
};
const run = (patch: Partial<GuardInput>) => guardToolCall({ ...base, ...patch });

test("implement mode allows ordinary edits", () => {
	assert.equal(run({}).action, "allow");
	assert.equal(run({ toolName: "edit", input: { path: "/repo/src/a.ts" } }).action, "allow");
	assert.equal(run({ toolName: "read" }).action, "allow");
});

test("generated output is blocked in every mode", () => {
	const decision = run({ input: { path: "templates/generated/x/y.yaml" } });
	assert.equal(decision.action, "block");
	assert.equal(run({ input: { path: "/repo/platform/kcc/config-operator.yaml" } }).action, "block");
	assert.equal(run({ input: { path: "platform/kcc/other.yaml" } }).action, "allow");
});

test("spec mode only edits docs", () => {
	assert.equal(run({ mode: "spec", input: { path: "docs/changes/x.md" } }).action, "allow");
	assert.equal(run({ mode: "spec", input: { path: "src/a.ts" } }).action, "block");
	assert.equal(run({ mode: "spec", input: { path: "docsx/a.md" } }).action, "block");
	assert.equal(run({ mode: "spec", input: { path: "../other/docs/a.md" } }).action, "block");
});

test("review mode is read-only", () => {
	assert.equal(run({ mode: "review", input: { path: "docs/changes/x.md" } }).action, "block");
	assert.equal(run({ mode: "review", toolName: "read" }).action, "allow");
});

test("checkpoints are for implementation only", () => {
	assert.equal(run({ toolName: "team_checkpoint", input: {} }).action, "allow");
	assert.equal(run({ mode: "spec", toolName: "team_checkpoint", input: {} }).action, "block");
	assert.equal(run({ mode: "review", toolName: "team_checkpoint", input: {} }).action, "block");
	assert.equal(run({ mode: "spec", toolName: "team_plan_slices", input: {} }).action, "allow");
});

test("Linear is reachable only through team tools", () => {
	assert.equal(run({ toolName: "linear_create_issue", input: {} }).action, "block");
	assert.equal(run({ toolName: "mcp__linear__save_issue", input: {} }).action, "block");
	assert.equal(run({ toolName: "team_checkpoint", input: {} }).action, "allow");
});

test("destructive git asks first; ordinary git does not", () => {
	const bash = (command: string) => run({ toolName: "bash", input: { command } }).action;
	for (const command of [
		"git reset --hard HEAD~1",
		"git reset -q --hard",
		"git -C /x reset --hard",
		"git -c core.editor=true reset --hard",
		"git clean -fdx",
		"git clean -d -f",
		"git clean --force",
		"git checkout -- src/a.ts",
		"git checkout HEAD -- a.ts",
		"git checkout .",
		"git checkout -f main",
		"git switch -f main",
		"git switch --discard-changes main",
		"git restore src/a.ts",
		"git restore --staged --worktree a.ts",
		"git stash drop",
		"git stash clear",
		"git push --force origin main",
		"git push -f",
		"git push --force-with-lease",
		"git push origin +main",
		"git push origin :old-branch",
		"git push --delete origin old",
		"git branch -D old",
		"git branch -d -f old",
		"git branch --delete --force old",
		"git worktree remove --force ../x",
		"cd sub && git reset --hard",
		"FOO=1 git clean -f",
		"/usr/bin/git reset --hard",
	]) {
		assert.equal(bash(command), "confirm", command);
	}
	for (const command of [
		"git status",
		"git restore --staged a.ts",
		"git checkout -b feature",
		"git switch -c feature origin/main",
		"git push -u origin x",
		"git push origin feature-f",
		"git push -u origin HEAD && gh pr create -f",
		"git push origin HEAD && rm -f /tmp/x",
		"git commit -m 'fix'",
		"git commit -m 'do not git reset --hard here'",
		'git commit -m "undo git clean -f; and git push --force"',
		"grep 'git clean -f' docs/WORKING.md",
		"git branch -d merged",
		"git worktree remove ../x",
		"git stash",
		"git log --oneline -5",
	]) {
		assert.equal(bash(command), "allow", command);
	}
});

test("bash cannot reach the Linear API, but reading about it is fine", () => {
	const bash = (command: string) => run({ toolName: "bash", input: { command } }).action;
	assert.equal(bash("curl -X POST https://api.linear.app/graphql"), "block");
	assert.equal(bash("cd x; curl https://API.linear.app/graphql"), "block");
	assert.equal(bash("node -e \"fetch('https://api.linear.app/graphql')\""), "block");
	assert.equal(bash("grep -rn api.linear.app src"), "allow");
	assert.equal(bash("git log -S api.linear.app"), "allow");
});

test("the guard judges the same file the host will write", () => {
	const generated = (path: string) => run({ input: { path } }).action;
	assert.equal(generated("@templates/generated/a.yaml"), "block", "leading @ is stripped by the host");
	assert.equal(generated("Templates/Generated/a.yaml"), "block", "case-insensitive filesystems");
	assert.equal(generated("file:///repo/templates/generated/a.yaml"), "block");
	assert.equal(generated("src/../templates/generated/a.yaml"), "block");
	assert.equal(run({ mode: "spec", input: { path: "@docs/changes/x.md" } }).action, "allow");
	assert.equal(run({ mode: "spec", input: { path: "@src/a.ts" } }).action, "block");
	assert.equal(run({ mode: "spec", input: { path: "~/elsewhere/docs/x.md" } }).action, "block");
	assert.equal(run({ mode: "spec", input: { path: "docs" } }).action, "block", "the directory itself is not a spec file");
});

test("shell commands are split on operators but not inside quotes", () => {
	assert.deepEqual(shellSegments("a b && c 'd; e' | f \"g && h\"\ni"), [["a", "b"], ["c", "d; e"], ["f", "g && h"], ["i"]]);
	assert.deepEqual(shellSegments("git commit -m ''"), [["git", "commit", "-m", ""]]);
});

test("destructive git is found inside ordinary shell forms", () => {
	const bash = (command: string) => run({ toolName: "bash", input: { command } }).action;
	for (const command of [
		"if ! git diff --quiet; then git reset --hard; fi",
		"for f in a b; do git checkout -- $f; done",
		"while true; do git clean -fd; done",
		"! git reset --hard",
		"{ git reset --hard; }",
		"# don't lose this\ngit reset --hard",
		"echo ok # it's fine\ngit clean -fd",
		"xargs git reset --hard",
		"git ls-files -m | xargs git checkout --  a",
		"git ls-files -m | xargs -n1 git checkout -f",
		"timeout 30 git reset --hard",
		"sudo -u x git clean -f",
		"env -i git reset --hard",
		"`git reset --hard`",
		'echo "$(git reset --hard)"',
		'echo "before `git clean -f` after"',
		"x=$(git stash drop)",
		"git reset --hard>/dev/null",
		"git clean -fd>/dev/null 2>&1",
		"git \\\n  reset --hard",
		"git stash \\\ndrop",
		"git checkout HEAD src/a.ts",
		"git checkout src/",
		"git checkout ./",
		"git checkout -B main origin/main",
		"git branch -f main HEAD~3",
		"git branch -M old new",
	]) {
		assert.equal(bash(command), "confirm", JSON.stringify(command));
	}
	for (const command of [
		"cat > notes.md <<EOF\nrun git checkout -- path to undo\ngit push --force is forbidden\nEOF",
		"git commit -F- <<'MSG'\nrevert: git reset --hard was wrong\nMSG",
		"echo hi # ; git reset --hard",
		"git restore -S a.ts",
		"git clean -nfd",
		"git clean --dry-run -fd",
		"git checkout main --",
		"git checkout feature/x",
		"git checkout -b feature origin/main",
		"git checkout -t origin/feature",
		"git checkout -",
		"git branch -m old new",
		"echo 'git reset --hard'",
		"xargs rm -f < list.txt",
	]) {
		assert.equal(bash(command), "allow", JSON.stringify(command));
	}
	// Both the here-doc body and what follows it are handled.
	assert.equal(bash("cat <<EOF\nharmless\nEOF\ngit reset --hard"), "confirm");
});

test("the Linear API guard blocks calls, including by variable, without blocking mentions", () => {
	const bash = (command: string) => run({ toolName: "bash", input: { command } }).action;
	for (const command of [
		'LINEAR_URL=https://api.linear.app/graphql\ncurl -s "$LINEAR_URL" -d @q.json',
		"URL=https://api.linear.app/graphql; curl $URL",
		"timeout 10 curl https://api.linear.app/graphql",
		"python3 -c \"import urllib.request as u; u.urlopen('https://api.linear.app/graphql')\"",
	]) {
		assert.equal(bash(command), "block", command);
	}
	for (const command of [
		"gh pr create --body 'uses https://api.linear.app/graphql directly'",
		"npm test -- --grep api.linear.app",
		"make verify # api.linear.app is mocked",
		"cat > doc.md <<EOF\nPOST https://api.linear.app/graphql\nEOF",
	]) {
		assert.equal(bash(command), "allow", command);
	}
});

test("sandbox guest paths are judged as the host files they are", () => {
	const at = (path: string, mode: "implement" | "spec" = "implement") => run({ mode, input: { path } }).action;
	for (const path of ["/workspace/templates/generated/a.yaml", "@/workspace/templates/generated/a.yaml", "file:///workspace/templates/generated/a.yaml", "@file:///workspace/templates/generated/a.yaml", "/workspace/src/../templates/generated/a.yaml"]) {
		assert.equal(at(path), "block", path);
	}
	assert.equal(at("/workspace/src/a.ts"), "allow");
	assert.equal(at("/workspace/src/a.ts", "spec"), "block");
	assert.equal(at("file:///workspace/docs/changes/x.md", "spec"), "allow");
	assert.equal(at("/workspacex/templates/generated/a.yaml", "spec"), "block", "a sibling of the mount is outside the repository");
});
