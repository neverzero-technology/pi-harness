---
name: discovery
description: Adopt the team workflow in an existing repository. Read its current agent harness, instruction files, specifications, PRDs, plans and task ledgers; write the repository profile; convert what is still live to the team's formats; remove what is replaced; and account for every removal. Use for /discover.
---

# Discovery

You are converting a repository to the team workflow in one reviewable pull request. Nothing may be lost: every old file you delete is either migrated somewhere you can name, or removed for a reason you state.

You change workflow configuration and documents only. Never edit product source, tests, build files or CI.

The only workflow file a repository holds is `.pi-team/profile.json`. The Linear team, state names, labels and model are team-wide settings in the harness itself; they are not set per repository and you cannot change them. If a tool reports that the Linear team, a state or a label is missing, stop and tell the human exactly what it said. Do not create other configuration files or try another route.

## 1. Read before writing

Work from the inventory the command printed, then look further:

- Read every agent instruction file and harness configuration file in full.
- Read the authoritative architecture and specification documents far enough to know what each one governs.
- Read the task ledger's index or status file, and enough individual entries to understand its format and which items are open.
- Find how changes are verified: the Makefile or task runner, package scripts, verification scripts, CI workflows and git hooks. Note what each gate needs (services, credentials, a cluster) and what it proves.
- Find generated files: generator scripts, `DO NOT EDIT` headers, `linguist-generated` attributes, and directories the documents say are produced by a tool.

Say what you found in a short summary before changing anything.

## 2. Write the profile

Write `.pi-team/profile.json` in the shape the command gave you.

- **name**: the repository's name.
- **docs**: two to six documents an agent should read first, most general first. Prefer maps and contracts over leaf documents.
- **verify.offline**: the gate that needs no external services. **verify.full** and **verify.selected** if the repository has them. Use the exact commands from its own scripts.
- **verify.notes**: what each gate needs, and which results are local, simulated, CI or live evidence. If a gate cannot run without something the agent may lack, say so here.
- **generated**: globs for checked-in files that a generator produces, so nobody may edit them by hand. Cover every such path and nothing hand-written. Build output that git ignores does not belong here; if the repository has no checked-in generated files, use an empty list.
- **invariants**: four to ten one-line rules a change must not break. Take them from the repository's own documents, in its own terms. Do not invent rules and do not copy general advice.
- **pins** and **consumers**: only if the repository pins another repository's release, or others pin its releases.
- **linear.label**: `repo:<name>`. Omit **linear.project**; it is added when `/discover linear` has run.

## 3. Convert what is still live

- **Authoritative documents stay where they are.** Architecture documents, long-lived specifications and decision records are not rewritten to a template. List the important ones in `docs`.
- **Change-shaped documents become change specifications.** For a PRD, plan or proposal describing work that is not finished:
  - write `docs/changes/<id>.md` from the template, keeping its requirements in the original's meaning;
  - give each requirement an ID and at least one scenario;
  - mark anything the original leaves undecided as `BLOCKING:` rather than deciding it yourself;
  - then delete the original and record it as migrated.
- **Finished or historical plans are not converted.** Leave them in place if they are still useful reference; otherwise delete them and record why.
- **Agent instruction files are reduced, not removed.** Rewrite `AGENTS.md` to what an agent needs that the profile does not hold:
  - what the repository is, in a few lines;
  - conventions for code and tests;
  - a pointer to `.pi-team/profile.json` for invariants and verification.
  
  Take out roles, slash commands, task-ledger procedures and anything else the workflow now does. If other instruction files only mirror `AGENTS.md`, delete them.

## 4. Remove what is replaced

Delete with `git rm`:

- agent harness configuration: role definitions, custom commands, rules files, harness settings;
- spec-tool scaffolding the workflow replaces.

Task and progress ledgers, and the scripts that maintain them, are not deleted in this step. They are removed in step 5, after their open work exists in Linear. Until then, leave them untouched.

Do not delete CI, git hooks, build configuration or anything the product needs to build, test or run. If an instruction file names a ledger or command you removed, fix the reference.

## 5. Linear

Do this only when asked to (`/discover linear`).

- Propose one project for the repository's current body of work.
- One issue per piece of open work: not started, in progress or blocked. Finished work is not imported.
- For each issue:
  - `source` is where it was recorded, for example `tasks/T012.md`. It must be stable, because it is how a second run avoids duplicates.
  - The description carries the acceptance in the original's terms, plus its previous status and owner if recorded.
  - `state` is `ready` only when the acceptance is clear and nothing blocks it. Otherwise `backlog`.
  - `dependsOn` lists the sources that must finish first.
- Never assign anyone and never mark anything in progress; people claim work with `/work start`.
- Call `team_project_populate` once with the whole proposal. The human sees a preview and confirms.
- If they decline, change nothing.
- Once the issues exist:
  - set `linear.project` in the profile;
  - delete the ledgers and their scripts with `git rm`, and fix any document that still points at them;
  - call `team_discover_report` again with the ledgers listed as migrated to the Linear project;
  - commit.

## 6. Report and commit

Call `team_discover_report`:

- **summary**: what the repository had and what it has now, in two or three sentences.
- **migrated**: each old file or directory, and where its content lives now.
- **removed**: each old file or directory deleted with no replacement, and why that is safe.
- **followUps**: what a person still has to decide or do. Include any verify gate that cannot run in the sandbox, and any rule you were unsure belonged in the invariants.

If the tool says deletions are unaccounted for, fix the report and call it again. Then commit everything on the adoption branch and tell the human to run `/discover linear` (if the repository has open work recorded anywhere) and `/discover pr`.

You cannot push or open the pull request yourself; `/discover pr` does that from the host.
