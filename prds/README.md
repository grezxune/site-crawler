
# PRDs

A PRD records what to build and why, in terms you can build and verify against. How it gets built lives in the code and in the PRD's Decisions section.

## When one is needed

Write a PRD before building a new feature or changing user-facing behavior. Bug fixes, refactors, and small tweaks go straight to code. Before building a feature, find its PRD in `prds/` and build against it.

Keep one PRD per feature at `prds/{feature}.md`. When scope or a decision changes mid-build, update the PRD in the same change as the code.

## Status

- `draft`: open questions remain. Resolve the ones a requirement depends on with the project owner before building that requirement.
- `approved`: requirements are settled. Build against them.
- `shipped`: every P0 requirement is live. Further changes go in a new PRD.

## Template

```markdown
---
title: Feature name
status: draft
---

## Problem
Who has the problem, what it costs them today, and why it matters now. Two to five sentences.

## Goals
Measurable outcomes with targets, e.g. "80% of new users finish setup in under 2 minutes."

## Non-goals
What this work leaves out on purpose, with the reason for each.

## Users and flows
Who uses it, and the main flow as numbered steps.

## Requirements

### R1 (P0): One sentence describing behavior the user sees
- Given ..., when ..., then ...

### R2 (P1): ...
- Given ..., when ..., then ...

## Constraints
Only what applies to this feature: performance budgets, security and privacy, integrations, migrations or rollout steps, deadlines.

## Open questions
- Blocks R2: the question.

## Decisions
- YYYY-MM-DD: The decision, and the reason.
```

Priorities: P0 ships in the first release. P1 should ship but can slip. P2 is later.

## Writing rules

- Write requirements as behavior the user sees. "Search returns results in under 300 ms" is a requirement. "Add an index on title" is an implementation choice and goes in Decisions if it matters.
- Give every requirement acceptance criteria that a person can check by running the tool or a test can assert.
- Problem, Non-goals, and Requirements are always present. Leave out any other section that would only say TBD or N/A.
- When the feature touches personal data or how the crawler treats other sites, list each risk under Constraints with how you will verify it.

## Building against a PRD

The P0 acceptance criteria are the definition of done. Before calling the feature finished, check every one and report any that fail. Reference requirement IDs (R1, R2) in commit messages and PR descriptions.
