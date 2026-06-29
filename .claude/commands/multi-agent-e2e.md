---
description: Design and run Playwright E2E tests for a user flow via a critic workflow (happy + failure/edge paths). Use when a flow needs new or expanded E2E coverage.
argument-hint: [target flow, e.g. "onboarding"]
---

Design and run E2E tests using a **deterministic multi-agent Workflow** (the critic
panel runs as parallel subagents in their own contexts) — not one agent simulating
critics.

Target flow:
$ARGUMENTS

Procedure:

1. Inspect existing Playwright tests, app routes, and components.
2. Start or reuse localhost; manually verify the target flow in browser.
3. **Enumerate test cases via a Workflow** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/e2e-design.js`, `args: { "flow": "$ARGUMENTS" }`.
   One agent per path category (happy, failure, edge, accessibility, regression)
   enumerates concrete cases in its own context; results are deduped. (Invoking
   Workflow here is expected.) It returns `{ flow, count, cases }`.
4. Implement Playwright tests from the returned `cases` (cover the happy path + at
   least one failure/edge path); run the specific specs.
5. Fix test or app failures, but do not weaken assertions.
6. Run browser verification again.
7. Report evidence.

Required output:

- E2E cases added
- browser flow verified
- commands run
- failures found
- files changed
- remaining coverage gaps
