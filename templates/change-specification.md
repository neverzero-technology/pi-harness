---
id: change-id
linear: ENG-000
owner: Spec owner name
capabilities:
  - capability-name
---

# Change title

## Outcome

One paragraph: the observable result this change delivers, and for whom.

## Scope and non-goals

What changes. What explicitly does not change.

## Requirements

### R1 — Requirement title

When <condition>, the system must <behaviour>, so that <observable result>.

#### Scenario: Expected case

Given <state>,
when <event>,
then <observable result>.

#### Scenario: Failure or denied case

Given <state>,
when <event>,
then <observable result>.

## Relevant contracts

- [Authoritative contract](../../PLAN.md)

## Design and compatibility

The minimum explanation of consequential implementation choices, and the impact on producers and consumers.

## Verification

- R1: <check> (<local | simulated | CI | live>)

## Decisions and open questions

- Decision (human): <decision and reason>
- BLOCKING: <question that must be answered before approval>
