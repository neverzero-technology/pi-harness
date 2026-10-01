---
name: requirements-interview
description: Interrogate a draft spec, epic or PRD with the human one focused question at a time, record answers as decisions, and surface what blocks approval. Use for /grill or when requirements are ambiguous before implementation.
---

# Requirements interview

The aim is to remove the uncertainty that would make implementation expensive or wrong, using as few questions as possible. No implementation happens during the interview.

## Before asking

1. Read the spec or issue and the decisions already recorded. Never re-ask something already answered.
2. List the uncertainties privately. Rank them by impact: what would change the outcome, the data model, permissions, compatibility or the verification plan if answered differently?
3. Skip anything the source code or authoritative documents already settle. Cite them instead of asking.

## Asking

- Ask **one** question per message. Make it specific and answerable.
- Where useful, offer two or three concrete options, mark your recommendation and say why in one line.
- Cover, as relevant:
  - outcome and non-goals;
  - who may do what (permissions, tenancy);
  - failure and retry behaviour;
  - compatibility with producers and consumers;
  - data retention and migration;
  - what counts as verified, and at which scope (local, simulated or live).
- After each answer, update the spec:
  - record the answer in "Decisions and open questions" as `- Decision (human): …`, or `- Decision (recommended): …` when the human accepts your recommendation without adding to it;
  - adjust the affected requirement and scenarios.
- Keep human answers and agent recommendations distinguishable. Never record your own recommendation, or a rule you read in a repository document, as the human's decision.
- If an answer does not address the question you asked, record what it does settle and ask the original question again.

## Stopping

Stop when the remaining questions would not change the implementation, or when the human says to stop. Then:

- Leave each unresolved question that must be answered before approval as `- BLOCKING: …`. Planning refuses specs that still contain one.
- Summarise what changed in the spec and what is still open.
- Run `team_spec_lint`.

Spec mode is on: only files under `docs/` can be edited.
