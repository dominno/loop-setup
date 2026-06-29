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
3. **Surface coverage gaps via the critic panel** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/critic-panel.js` and (on one line)
   `args: { "focus": "E2E coverage of the $ARGUMENTS flow: critical paths, failure/edge/recovery states, accessibility, and regressions" }`.
   The QA/E2E, First-Time User, UX Flow, Accessibility, and Regression critics each
   report in their own context; findings are adversarially verified.
4. Draft E2E test cases from the workflow's `confirmed` findings (happy + at least
   one failure/edge path).
5. Implement Playwright tests; run the specific specs.
6. Fix test or app failures, but do not weaken assertions.
7. Run browser verification again.
8. Report evidence.

Required output:

- E2E cases added
- browser flow verified
- commands run
- failures found
- files changed
- remaining coverage gaps
