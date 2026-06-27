---
description: Full multi-agent critic-led development loop for a non-trivial feature, bug fix, or UI change; ends with browser + test evidence. The default for substantive work.
argument-hint: [task, e.g. "build the login page"]
---

Run a full multi-agent development loop for this local web app.

User task:
$ARGUMENTS

You are the Lead Agent.

You must use the following critic agents before implementation:

1. First-Time User Critic
2. UX Flow Critic
3. Designer Critic
4. Artistic Direction Critic
5. Frontend Architecture Critic
6. QA / E2E Critic
7. Accessibility Critic
8. Performance Critic
9. Security Critic
10. Regression Critic

Procedure:

1. Read CLAUDE.md.
2. Read package.json.
3. Inspect the relevant routes, components, API handlers, tests, and styles.
4. Start or reuse the local dev server.
5. Open the relevant localhost page using Chrome or Playwright MCP.
6. Observe the current behavior.
7. Run the critic round before implementation.

For each critic, produce:

- severity: blocker / important / nice-to-have
- finding
- evidence
- recommended fix

Then:

8. Synthesize findings as Lead Agent.
9. Choose the smallest safe implementation plan.
10. Implement only blockers and important issues directly related to the task.
11. Run the smallest relevant automated checks first.
12. Verify in browser on localhost.
13. Check console errors.
14. Check failed network requests.
15. Add or update Playwright E2E tests for the verified flow.
16. Run relevant E2E tests.
17. Run typecheck, lint, unit tests, and build if appropriate.
18. Run a second critic round after implementation.
19. Fix remaining blockers.
20. Report final evidence.

Never mark complete unless:

- the flow works in browser
- no blocking console errors remain
- relevant E2E tests pass
- post-implementation critic round has no blockers
- files changed are reported
- remaining risks are listed

Do not push or deploy.
Do not delete tests.
Do not weaken assertions to pass.
Do not make unrelated refactors.
