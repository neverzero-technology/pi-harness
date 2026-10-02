# pi-team

One Pi package that brings the team's working process to any repository:

- bounded change specs;
- Linear as the single record of ownership and progress;
- checkpoints that survive session loss;
- an independent read-only review;
- a truthful finish.

| Fact | Lives in |
| --- | --- |
| Intended behaviour of a change | `docs/changes/<id>.md`, approved by merging its PR |
| Maintained capability contract (opt-in) | `docs/specs/<capability>.md` |
| Implemented behaviour | Source and tests |
| Assignment, state, blockers, dependencies, checkpoints | Linear |
| Branches, commits, PRs, integration | Git and GitHub |
| Unsynced recovery data and agent review records | `.git/pi-team/` (local only, never shared progress) |
| Team-wide behaviour and defaults | This package (`team.json`) |
| One repository's rules for the workflow | That repository's `.pi-team/profile.json`, in force once merged to its default branch |

## Install and run

You need:

- **Node.js 24 or newer**, Pi **1.0.0** (the tested host), and npm;
- **QEMU** on macOS or Linux, on ARM64 or x86-64;
- Git, the GitHub CLI signed in, and your own Codex and Linear credentials.

On macOS: `brew install node qemu gh`. On Debian/Ubuntu ARM64: `sudo apt install qemu-system-arm`; on x86-64: `sudo apt install qemu-system-x86`. Install Node 24+ separately if the distribution package is older. Linux hardware acceleration needs access to `/dev/kvm`; Gondolin can also use slower software emulation.

`npm install` installs the pinned `@earendil-works/gondolin@0.12.0` runtime. The first session downloads and caches its Linux guest assets (about 200 MB or more), so it needs internet access and can take longer to start. Subsequent sessions reuse that image cache. Normal coding sessions also need network access to install missing baseline guest tools (`bash`, `git`, `nodejs`, `npm`); a custom image that includes them skips this setup. No Apple Container or Docker installation is needed.

```sh
# From this checkout, until the package is published:
npm install
./bin/pi-team.mjs            # run from inside a team repository

# Once published (private registry):
npm exec --package=@neverzero/pi-team@0.2.0 -- pi-team
```

The launcher starts Pi with:

- only this package's extension and skills, including the mandatory Gondolin sandbox;
- the pinned model;
- `--no-extensions --no-skills --no-prompt-templates --no-approve`.

Personal extensions, skills, prompt templates and MCP servers (including any Linear MCP) are not loaded, and project `.pi/` configuration is ignored. Repository `AGENTS.md` files still load because they hold the domain invariants. Set `launcher.contextFiles` to `false` in `team.json` to change that.

Use **`pi-team`** for enforced harness sessions. It checks Node/QEMU and runtime imports before launching, and refuses extra `-e`/`--extension`, `--skill`, or `--prompt-template` resources that could replace the sandbox. There is no sandbox disable flag. VM startup or execution failures block tools; they never fall back to host execution. `/team doctor` reports whether the VM is ready.

`pi install` (or `pi -e <path>`) also registers the sandbox, but personal extensions can run with host permissions or replace tools. `/team doctor` warns about that setup; it is outside the launcher's enforced resource isolation.

Authentication is individual. Never share `auth.json`, keys or tokens.

- **Codex**: sign in with Pi as usual.
- **Linear**: create a personal API key (Linear → Settings → Security & access). Then either `export LINEAR_API_KEY=…`, or save it to `~/.config/pi-team/linear-api-key` with `chmod 600`.
- **Check**: run `/team doctor`. It checks the host and model versions, whether your account has the team model, isolation, repository profile, Linear identity, team, workflow states, labels and `gh`. `/team setup` prints these steps inside a session.

## Commands

| Command | What it does | Enforced in code |
| --- | --- | --- |
| `/spec draft <issue\|idea>` | The agent picks a proportionate path, then drafts `docs/changes/<id>.md` from the template | Spec mode: edits outside `docs/` are blocked |
| `/spec lint [path]` | Structural check: frontmatter, sections, requirement IDs, scenarios, links, `BLOCKING:` questions, size | Deterministic |
| `/grill <spec\|issue>` | One question at a time; answers recorded as decisions | Spec mode |
| `/align <spec\|issue>` | Report of blocking contradictions, decisions required, verification gaps and what is aligned | Review mode (read-only); adds lint, capability overlap and any release pins the profile declares as facts |
| `/spec plan <spec>` | Turn an approved spec into small dependent Linear issues | Lint and blocking questions gate it; unapproved specs are preview-only; same slice key means reuse; the human confirms before creation |
| `/work next` | Recommends your unblocked work, unassigned Ready issues for this repo, and planned Backlog slices whose prerequisites are done | Never claims anything |
| `/work start <issue>` | Ownership and checkout preflight, then a briefing for the session | Refuses another person's issue or another repo's issue; one confirmation per exception; all decisions are taken before anything changes; ownership is re-read just before writing; worktree or branch switch; a start checkpoint that never overwrites earlier progress (a handoff carries the previous owner's remaining work forward) |
| `/work status` | Session, branch, unsynced state, Linear state and latest checkpoint | Shows when Linear is unreachable |
| `/work checkpoint [note]` | The agent records a checkpoint through `team_checkpoint` | Only the owner can checkpoint; Git facts filled in by code; secrets redacted; a failed post is saved locally and reported as unsynced |
| `/work block <reason>` / `--clear` | Adds or removes the `blocked` label with a comment | Owner only; workflow state is unchanged |
| `/work resume [issue]` | Reconciles the latest checkpoint, pending local checkpoint, branch, commits and PR | No ownership claims while Linear is down; someone else's issue opens in read-only review mode |
| `/review [issue]` | Fresh `pi` process with a read-only Gondolin workspace and `read`/`grep`/`find`/`ls` only reviews the diff against acceptance and constraints | Verdict and commit recorded per issue in `.git/pi-team/reviews/` only when the tree was clean; flags open PRs touching the same files |
| `/work push` | Pushes the issue branch to origin from the host and opens a draft PR if none is open | Owner only; issue branch only, never the default branch; confirmed first; never forced; uncommitted files are left out |
| `/work finish [issue]` | Reports each completion condition, has the agent assess acceptance into a final checkpoint, then offers In Review or Done | See "What finish checks" below; every transition needs the human's confirmation |
| `/discover` then `/discover linear`, `status`, `pr` | Adopts the workflow in an existing repository; see "Adopting a repository" | Own branch from the default branch, in a separate worktree when the checkout has work in progress; discover mode edits only workflow configuration and documents; every deleted file must be accounted for; Linear writes are previewed and confirmed; the PR is raised from the host |
| `/team doctor` / `setup` / `version` / `status` / `mode <implement\|spec\|review>` | Setup check, sign-in steps, versions, team-wide view of active, in-review and Ready work, and manual mode switch | |

The agent-facing tools are:

- `team_issue_read`, `team_issue_search` and `team_spec_lint` (read-only);
- `team_checkpoint` and `team_plan_slices`, the only ways the agent itself can write to Linear. Every other Linear write (assigning, moving state, blocking) happens inside a command you run.

### What finish checks

`/work finish` marks each condition ✓, ✗ or ? (needs human judgement):

- **Checks**: the latest recorded result of each command across all checkpoints, judged at one commit (see below). At least one pass there is required and any failure there is ✗. Skipped or unavailable checks, and results recorded at another commit or on a tree with uncommitted changes, are listed as ? for a person to weigh.
- **Agent review**: `/review` ran at HEAD on a clean tree and returned "ready for human review". Acceptance that needs live evidence does not by itself fail the review; it stays listed as unmet.
- **Local state**: before the merge, nothing uncommitted and the branch pushed to its own branch on origin. After the merge, nothing uncommitted and no local commits beyond what was merged.
- **Pull request**: exists for the issue's branch, its head is your HEAD while it is open, a person other than the author approved it with no outstanding change request, remote checks pass, and it is merged. If GitHub cannot be queried this is ✗, not unknown.
- **Prerequisites**: no open blocking issue and no `blocked` label.
- **Acceptance**: the owner's most recent checkpoint at that commit is a final one recording nothing remaining. The agent writes it after comparing each acceptance item with the evidence; unmet live gates stay listed. A later progress or blocked checkpoint at the same commit withdraws it.

It offers **In Review** when the PR is open and only review, remote checks, merge or unmet acceptance (typically a live gate) remain. It offers **Done** only when the PR is merged and nothing is ✗, and shows the ? items in the confirmation. It skips the acceptance assessment while checks or review are failing, because that commit has to change.

The commit the evidence is judged at is your HEAD while the PR is open, and the merged PR head once it is merged. So after a squash merge that deleted the branch you can run `/work finish ENG-201` from the default branch and still reach Done; the PR is found through the branch name recorded in the last checkpoint.

### Typical flows

```text
/spec draft ENG-142 → /grill docs/changes/tenant-identity.md → /align docs/changes/tenant-identity.md
→ open a PR for the spec, another person reviews and merges it (that is the approval)
→ /spec plan docs/changes/tenant-identity.md

/work start ENG-201 → implement, commit, checkpoint → /work push → /review → /work finish (→ In Review)
→ another person reviews and merges the PR → /work finish (→ Done)
/work resume ENG-201        # after a crash, context rotation or handoff

/discover → the agent writes the profile, converts and removes old material, files its report, commits
→ /discover linear → /discover pr → another person reviews and merges (the profile is now in force)
```

## Guards and their limits

Gondolin runs `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and user `!`/`!!` shell commands inside a Linux micro-VM. The current working directory is mounted at `/workspace` and its original absolute path; changes write through to the host. Start at the repository root. Each session gets a disposable VM: guest-installed packages and files outside the mounts disappear when it closes. Cancelling or timing out a shell command closes the VM to stop all guest processes; the next tool call boots a fresh VM. The harness installs Bash, Git, Node.js and npm in the default Alpine guest automatically. It may require extra build tools; install them inside the guest with `!apk add ...`, or select a suitable Gondolin image with `GONDOLIN_DEFAULT_IMAGE`. Native dependencies must be installed for Linux; host macOS binaries in `node_modules` will not work in the guest.

Harness skills, templates and review instructions are mounted read-only. Linked worktrees also mount their shared Git metadata at its original path, so Git works without exposing the main checkout. `/work start` still creates sibling worktrees on the host; follow its `cd ... && pi-team` instruction to start a new VM there. The independent reviewer has read-only workspace and Git mounts, no shell tools, and no team/Linear tools.

Host environment variables are not forwarded to guest commands, including API keys, `LINEAR_API_KEY`, `PATH`, and SSH-agent sockets. Host Pi authentication, trusted workflow commands, Git/GitHub helpers, Linear requests, session storage and explicit user attachments remain on the host. Gondolin isolates repository tools; it does not sandbox the Pi process or trusted extension code. Install the harness outside agent-writable repositories. Workspace files such as `.env` are still visible when they are part of a mount. Guest network access uses Gondolin's default policy; this harness does not add a destination allowlist.

The following workflow controls apply alongside the VM boundary:

- **Generated paths**: writes and edits to the globs a repository's profile lists as generated are blocked in every mode. Paths are resolved the way Pi's own write and edit tools resolve them.
- **The profile itself**: `.pi-team/` can only be written in discover mode, and the copy on the default branch is the one in force, so a local edit changes nothing until a pull request merges it.
- **Spec mode**: edits only under `docs/`. Spec and review modes raise the thinking level to the team's review setting; implement mode restores the default.
- **Review mode**: no write or edit at all.
- **Secrets**: text posted to Linear (checkpoints, block reasons, planned issues) is passed through a redactor for common key and token formats. It is a backstop, not a licence to paste secrets.
- **Compaction**: before Pi compacts the context, the session warns if the issue has work since its last checkpoint, and afterwards restates which issue and mode it is in.
- **Linear**: tools whose name contains `linear`, other than the `team_*` tools, are blocked, as is a `bash` command that calls `api.linear.app`. Checkpoints can only be posted in implement mode, by the issue's owner.
- **Destructive git**: asks the human first, and is blocked without a UI. Covered: `reset --hard`, `clean -f`, `checkout -f`, `checkout -B` or a `checkout` that names paths, `switch -f`, `restore` of the working tree, `stash drop|clear`, forced or deleting pushes, `branch -D` / `-f` / `-M`, `worktree remove --force`. Commands are parsed word by word: the same text inside a commit message, a `grep` pattern, a comment or a here-doc does not trigger it, and it is still found after `then`/`do`, inside `$(…)` or backticks, and behind `xargs`, `timeout`, `sudo` or `env`. A command hidden inside `bash -c "…"`, `eval` or a script is not seen.
- **Bash** can change any writable workspace or shared Git metadata inside the VM, including generated files and docs outside spec mode. The path guards cover `write`/`edit`; they are not shell-level mode restrictions. Linux commands cannot run host macOS tools such as Xcode. Credentials or a kubeconfig are never authorisation for live operations.
- **Linear has no atomic claim.** Ownership relies on explicit assignment, refusal to take another person's issue, visible checkpoints and reconciliation.
- **Retries:** a retried create or comment after an uncertain failure can duplicate. Planning recovers by slice key; checkpoints carry an id that resume checks before reposting.
- **Spec staleness:** any change to the spec on the default branch after planning triggers a warning, including typo fixes. A human decides whether it matters.
- **Checks are stamped when the checkpoint is posted**, not when the check ran. Run the final checks on the committed tree and checkpoint straight away; the delivery skill says so.
- **Teammates are trusted.** The metadata footer in an issue description and the format of a checkpoint comment can be written by hand. Only the owner's final checkpoint counts as the acceptance assessment, but nothing stops a teammate editing Linear directly.
- **New branches do not track `main`.** `/work start` creates the issue branch without an upstream. Publish it with `/work push`; nothing inside a session can push, because the sandbox has no host credentials.
- **Host-side git ignores repository hooks.** The harness's own git commands (status, fetch, switch, worktree, push) run on the host against files the sandboxed agent can write, so they run with hooks and the fsmonitor command disabled. A pre-push hook therefore does not run on `/work push`. Other config-driven commands, such as filters or a custom ssh command, are not covered.
- **Commits happen in the guest**, with the name and email from your host git config, so commit hooks run inside the VM.

## Configuration

`team.json` holds the nonsecret team defaults:

- host version;
- model and thinking levels;
- Linear team name and key, state-name mapping and blocked label;
- branch prefix and worktree location;
- spec directories and size thresholds.

Each repository holds its own rules in `.pi-team/profile.json`:

- `name`, and the Linear label (`repo:<name>` by default) and project for its issues;
- `docs`: the documents an agent reads first;
- `verify`: the offline gate, optional selected and full gates, and notes on what each proves;
- `generated`: globs of files that must not be hand-edited;
- `invariants`: the rules a change must not break, in the repository's own terms;
- `pins` and `consumers`: releases of other repositories it pins, and repositories that pin it.

The package ships no repository profiles. A change to `team.json` is a package release: bump the version, run `npm run check` and `npm run smoke:pack`, then pilot. A change to a profile is a pull request in that repository.

## Adopting a repository

Run `pi-team` in the repository and use `/discover`. It works for a repository with no agent setup at all, and for one that already has another harness, its own specification format, PRDs or a task ledger.

1. **`/discover`** works on a `pi-team/adopt` branch created from the default branch. If your checkout has uncommitted or untracked files, it leaves them alone and offers to create a separate worktree for the adoption instead; you then start `pi-team` in that worktree and run `/discover` again. It lists what it found by name: agent instruction files, harness configuration (`.claude/`, `.codex/`, `.cursor/`, Spec Kit, Kiro, OpenSpec and similar), specifications and plans, task ledgers, verification entry points, CI and hooks. The agent then, following the discovery skill:
   - writes `.pi-team/profile.json` from the repository's own documents and scripts;
   - converts unfinished PRDs, plans and proposals into change specifications under `docs/changes/`, and leaves authoritative architecture documents where they are;
   - reduces `AGENTS.md` to what the profile does not hold, and deletes old harness configuration and task ledgers;
   - files a report saying where each old file's content went, or why it was removed.
2. **`/discover linear`** first asks you which Linear project the repository's work belongs in: one of your existing projects, or a new one that you name. It asks only the first time; after that it uses the project recorded in the profile. The agent then proposes an issue for each piece of open work in the old ledgers, in that project. You see the whole proposal and nothing is created until you confirm. Finished work is not imported, nobody is assigned, and running it again reuses what exists.
3. **`/discover status`** says what still stands between the branch and a pull request.
4. **`/discover pr`** pushes the branch from the host and opens the pull request. Its description is built from the report, the Linear project and the actual file changes, with a review checklist. It refuses while anything is uncommitted, the profile is missing or invalid, or a deleted file is not covered by the report.

The profile takes effect for everyone when that pull request merges. Until then it applies only on the adoption branch, and `/team doctor` says so.

### Inputs to confirm before first use

- **Guest toolchain.** The stock guest image has bash, Python, Node and npm, plus git installed at session start. It has no `make`, Go, Docker or `gh`. A repository whose verify gate needs those cannot run it in the sandbox, so the agent would have to record those checks as unavailable. Build a custom Gondolin image with the toolchain (and git, to drop the per-session install) before piloting there.
- **Linear team**: `team.json` names the team (`linear.teamName`) and its issue prefix (`linear.teamKey`), and maps the workflow's logical states to the team's state names. `/team doctor` checks that the key belongs to the named team and that every state exists.
- **Labels**: create `blocked` and a `repo:<name>` label for each repository in Linear. `/team doctor` checks them for the repository you are in.
- **`model.id`**: `openai-codex/gpt-6.1-sol` is provisional until every account is confirmed to have access to it.
- **Package scope and registry**: `package.json` is `"private": true` so it cannot be published by accident. Remove that only under explicit publication authority.


## Development

```sh
npm install
npm run check            # type-check + unit tests (fake VM/Linear, real git in temp repos)
npm run test:sandbox     # real Gondolin VMs; needs QEMU and guest assets
npm run test:e2e         # workflow scenarios driving the real Pi host over RPC, with a fake Linear and fake gh
npm run check:linear     # validates all 20 GraphQL operations against Linear's published schema
PI_TEAM_SMOKE_PI=1 npm run smoke:pack   # packed tarball; also loads it in the real Pi host
```

The sandbox tests exercise real guest file/search/shell tools, host isolation, read-only mounts, worktrees, cancellation and VM failure behavior. The workflow end-to-end tests also need QEMU because they use the mandatory sandbox.

The end-to-end tests start Pi with a deliberately invalid model key, so a command that hands work to the model fails fast instead of spending quota. `PI_TEAM_LINEAR_URL` points the client at the fake; it is honoured only for `http://127.0.0.1` or `localhost`, so the key cannot be sent anywhere else.

What the tests do not prove:

- live Linear authentication, permissions and workspace configuration;
- whether Linear rewrites the Markdown in comments and descriptions (parsing tolerates the common rewrites);
- that the queries stay inside Linear's complexity budget (pages are 50 items with bounded nested lists, which should be well inside it).

Qualify those once, against a disposable Linear project, with `/team doctor`, `/team status` and a throwaway issue taken through `/work start` and a checkpoint.
