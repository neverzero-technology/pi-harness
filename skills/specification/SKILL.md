---
name: specification
description: Draft a bounded, testable change specification from an epic, PRD, issue or idea, and plan it into small Linear slices. Use for /spec draft and /spec plan, or when someone asks to write or decompose a spec.
---

# Change specifications

A change spec states intended behaviour for one coherent outcome. Source and tests state implemented behaviour; Linear states execution progress. Do not mix the three.

## 1. Choose the proportionate path first

Say which path applies before writing anything:

- **Small, understood fix**: no spec. The Linear issue holds 100–300 words of acceptance. Stop and say so.
- **Uncertain feasibility**: a read-only spike comes first. Report findings; do not implement.
- **Behavioural feature or material change**: write a change spec.

An existing useful PRD serves as the epic brief. Do not generate a duplicate.

## 2. Gather only relevant context

- Read the source issue or PRD (`team_issue_read`) and the authoritative documents named for the repository.
- Search for existing specs in `docs/changes/` and related work (`team_issue_search`). Extend or reference rather than duplicate.
- For a cross-repository change, write one canonical spec in the lead repository. Consumer issues link to it; they never copy it.

## 3. Write the spec

Copy the template given in the command, write to `docs/changes/<id>.md`, and keep `id` equal to the file name.

- **Outcome**: one paragraph naming the observable result for a user or system.
- **Scope and non-goals**: what changes and what explicitly does not.
- **Requirements**: about 5–12. Each one is `### R1 — Title` with one paragraph of behaviour:
  - state the trigger or condition, the behaviour, and the observable result;
  - use EARS-style wording ("When…, the system must…") where it clarifies;
  - include failure, retry, retention or migration behaviour where relevant;
  - give each requirement at least one `#### Scenario:` written Given/when/then;
  - security rules need an allowed scenario and a denied scenario.
- **Requirement prefixes**: use `Added:`, `Modified:` or `Removed:` only when a maintained capability baseline exists in `docs/specs/<capability>.md`. Otherwise number requirements locally (R1…Rn) with no prefix. Never renumber IDs once they are referenced.
- **Relevant contracts**: link the authoritative documents and schemas. Do not restate field inventories, types or defaults in prose; the schema keeps that authority.
- **Design and compatibility**: the minimum explanation of consequential choices and consumer impact. Keep it as a section here; write a separate design document only if it is long and genuinely helps.
- **Verification**: the checks that would prove each requirement, and their scope (local, simulated, CI or live). Name any live gate explicitly.
- **Decisions and open questions**:
  - `- Decision (human): …` only for something the human told you in this conversation.
  - `- Decision (recommended): …` for a choice you made that the human has not confirmed.
  - A rule that already exists in a repository document is not a decision: link it under "Relevant contracts".
  - `- BLOCKING: …` for any question that must be answered before approval.

## 4. Size

- Target 500–1,200 words. Lint warns above 1,500 words or 15 requirements.
- One coherent outcome, one accountable owner, a reviewable set of decisions.
- If it grows past that, split it into several changes rather than trimming security or lifecycle requirements.

Run `team_spec_lint` until it reports no errors. Lint checks structure only; it does not mean the spec is right.

## 5. Approval

A spec is approved when its PR is reviewed by a different person and merged to the default branch. That records the revision and the reviewer. Changing consequential requirements later needs another reviewed PR.

You never approve a spec, and a frontmatter field cannot approve it.

## Planning slices (/spec plan)

1. Search first and reuse equivalent issues. `team_issue_search` matches every word, so run a few short searches (the spec id, a capability name, a key file path) rather than one long one.
2. Propose small slices, usually a day or two of focused work each. For each slice give:
   - a stable `key` of the form `<spec-id>/<short-name>`, reused on every replan;
   - concrete acceptance that is a subset of the spec;
   - requirement IDs, affected surfaces and the verification with its scope;
   - `dependsOn` naming the slice keys that must finish first.
3. For a cross-repository change:
   - separate producer and consumer slices;
   - for a consumer that pins the producer release, add a publication and pin-update slice as an explicit dependency.
4. Separate source delivery from live qualification when live evidence needs authorisation or infrastructure the implementer may not have.
5. Call `team_plan_slices`. It previews reuse versus creation, and the human confirms before anything is created.
6. If it stops part-way, call it again with the same keys. Existing slices are reused, not duplicated.

Do not create a local task list or progress file. Linear holds execution state.
