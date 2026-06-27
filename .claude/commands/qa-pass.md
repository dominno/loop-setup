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
12. Run a post-implementation critic round using:
    - First-Time User Critic
    - UX Flow Critic
    - Designer Critic
    - QA / E2E Critic
    - Accessibility Critic
    - Regression Critic
13. Report blockers, non-blockers, and recommended next actions.

Never mark as complete if build, tests, or critical browser flow fails.
