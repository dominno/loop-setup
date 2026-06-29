---
description: Complete pre-ship QA pass — typecheck, lint, unit, build, E2E, browser check, a11y basics, and a post-implementation critic round. Run before committing/shipping a change set.
argument-hint: [scope, e.g. "changed auth flow"]
---

Perform a complete QA pass before shipping.

Scope:
$ARGUMENTS

Checklist:

1. Inspect changed files with git diff.
2. Run typecheck.
3. Run lint.
4. Run unit tests.
5. Run production build.
6. Run E2E tests.
7. Open localhost in browser.
8. Manually verify the main changed flows.
9. Check console errors.
10. Check failed network requests.
11. Review accessibility basics:
    - buttons have accessible names
    - forms have labels
    - keyboard navigation works for critical flow
12. Run a **post-implementation critic round as a Workflow** — invoke the Workflow
    tool with `scriptPath: .claude/workflows/critic-panel.js` and
    `args: { "focus": "the changed flows for $ARGUMENTS", "priorEvidence": "<git diff summary + the typecheck/lint/unit/build/E2E results + a11y/browser findings from steps 2-11>" }`.
    The critics run as parallel subagents and verify against that evidence; each
    blocker/important finding is checked by a separate skeptic (no single agent
    simulating the panel).
13. Report the workflow's `confirmed` blockers/non-blockers and recommended next
    actions.

Never mark as complete if build, tests, or critical browser flow fails.
