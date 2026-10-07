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
    `args: { "focus": "the changed flows for $ARGUMENTS", "priorEvidence": "<git diff summary + the typecheck/lint/unit/build/E2E results + a11y/browser findings from steps 2-11>", "priorRecords": <pnpm -s trace query --latest --writer critic-panel --json>, "treeId": "<pnpm -s trace tree-id>" }`.
    The critics run as parallel subagents and verify against that evidence; each
    blocker/important finding gets a typed verdict from a separate skeptic (no single
    agent simulating the panel). Record the verdicts per the **consumer protocol** in
    `.claude/memory/topics/trace.md` (scratchpad file → `pnpm trace write <file>` →
    `pnpm trace act --from <file>`).
13. Report the workflow's `confirmed` findings (with verdicts and qualifiers), the
    `deferred` ones with their `missing` evidence, the `revised` ones with their `repair`,
    any `failedReviewers`, and recommended next actions.

Never mark as complete if build, tests, or the critical browser flow fails, if any
blocker is open (confirmed, deferred or revised — a defer is not a pass until its
`missing` evidence is supplied and re-adjudicated, or a human accepts the risk), or if a
reviewer failed in the critic round.
