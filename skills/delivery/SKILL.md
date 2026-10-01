---
name: delivery
description: Implement one assigned Linear issue as a bounded slice with honest verification, checkpoints and review, through to a truthful finish. Use after /work start or /work resume, or whenever implementing team work.
---

# Delivery

You implement one issue's acceptance. The human owns product decisions, approval and final review.

## Scope

- Work only from the briefing: the issue's acceptance, the spec revision and the repository constraints.
- If you find needed work outside the acceptance, report it as a separate issue proposal. Do not absorb it, and never silently expand or shrink acceptance.
- If intent and implementation disagree, report the drift. Do not rewrite acceptance to match the code.
- Preserve unrelated changes in the checkout. Never reset, clean or stash someone else's work.

## Loop

1. Pick the next small, bounded step towards the acceptance.
2. Implement it with tests at the right level. Follow the repository invariants exactly; generated output is changed through its generator.
3. Run the affected verification from the briefing:
   - start with the offline gate and the suites for the touched surfaces;
   - widen when you touch shared contracts or producers.
4. Record results honestly:
   - give the command, a result of pass, fail, skipped or unavailable, and a scope of local, simulated, CI or live;
   - a skip is never a pass, and simulated status is never live evidence;
   - credentials or a kubeconfig are not authorisation for live checks.
5. Commit in coherent steps. Your commands run in a sandbox with no credentials, so you cannot push or open a pull request: ask the human to run `/work push`, which publishes the branch and opens a draft PR from the host. Suggest it early so the work is visible.
6. Run the final checks on the committed tree, then checkpoint before changing anything else. A check is recorded against the commit that is HEAD when you checkpoint, so a check run before the last edit proves nothing about the commit.

## Checkpoints

Call `team_checkpoint`:

- after a meaningful slice;
- on a material blocker (also suggest `/work block`);
- before stopping, handing off or deliberately rotating context.

Do not checkpoint after every tool call. If a checkpoint reports that shared progress is not confirmed, say so plainly; do not claim the update happened.

## Review and finish

- When the acceptance looks met and checks pass at HEAD, commit, then ask the human to run `/review`. Address substantive findings.
- `/work finish` lists the mechanical conditions. Assess each acceptance item honestly against evidence.
- An issue reaches done only when all of these hold:
  - all acceptance is met, including required runtime or live gates;
  - checks pass against the proposed source;
  - findings are resolved;
  - a different person has reviewed it;
  - remote gates pass;
  - the change is merged.
- Merged source with unmet live acceptance is not done. Record it in the final checkpoint; never quietly move it to another issue.
