---
name: alignment
description: Check a change spec or issue against the PRD, architecture documents, current source, producer/consumer contracts and pinned upstream releases, and report contradictions, required decisions and verification gaps with citations. Use for /align or before approving or starting substantial work.
---

# Alignment

Alignment is a targeted, evidence-based comparison. It is not a proof of correctness, and "aligned" never substitutes for approval.

## Compare

Check only what the change touches:

1. **Intent**: PRD or epic versus spec. Is anything promised in one but missing or contradicted in the other?
2. **Architecture**: spec versus the repository's authoritative documents and invariants.
3. **Source**: spec versus current code and tests. Report where behaviour the spec assumes does not exist yet, or exists differently.
4. **Producers and consumers**:
   - Who produces the schemas, resources or APIs this change uses, and who consumes what it changes?
   - Are affected-consumer tests named?
5. **Pinned upstream**:
   - Compare against the pinned release named in the facts, not the producer's latest checkout.
   - If the change needs an unreleased producer feature, a publication and pin-update dependency is required.
6. **Concurrent changes**: other active specs or issues touching the same requirement IDs, capabilities or resource surfaces.
7. **Repository rules**: check the change against each invariant in the briefing, e.g. tenancy, single-writer, generated output, evidence scope and authorisation boundaries.

## Report

Group findings under exactly these headings and cite the owning document, `path:line` or issue for each:

- **Blocking contradiction**: the spec cannot be implemented as written without breaking an authoritative contract.
- **Decision required**: a choice a human must make. Give the options and your recommendation.
- **Verification gap**: a requirement with no adequate check, or a check at the wrong scope (for example, simulated where live is claimed).
- **Aligned**: what you checked and found consistent, briefly.

Keep static compatibility findings separate from runtime or live-verification gaps. Do not edit anything; this is a read-only report.
