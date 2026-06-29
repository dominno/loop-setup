---
description: Full multi-agent critic-led development loop for a non-trivial feature, bug fix, or UI change; ends with browser + test evidence. The default for substantive work.
argument-hint: [task, e.g. "build the login page"]
---

Run a full multi-agent development loop for this local web app.

User task:
$ARGUMENTS

You are the Lead Agent. The critic rounds run as a **deterministic multi-agent
Workflow** (critics fan out as parallel subagents in their own contexts; each
blocker/important finding is verified by a separate skeptic) — **not** one agent
simulating critics. Invoking the Workflow tool here is expected (this command opts
into multi-agent orchestration).

Procedure:

1. Read CLAUDE.md and package.json.
2. Inspect the relevant routes, components, API handlers, tests, and styles.
3. Start or reuse the local dev server; open the relevant localhost page (Chrome/
   Playwright MCP) and observe current behavior.
4. **Pre-implementation critic round** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/critic-panel.js`,
   `args: { "focus": "$ARGUMENTS (current behavior + changed files)" }`.
   Render the returned `confirmed` findings as the critic matrix; record
   `niceToHaves`; ignore `refuted`.
5. As Lead Agent, choose the smallest safe plan from the confirmed blockers +
   directly-related important findings.
6. Implement only those. Keep the **maker/checker split**: implementation is your
   pass; the post-implementation workflow below is the independent checker.
7. Run the smallest relevant automated checks first.
8. Verify in browser on localhost; check console errors and failed network requests.
9. Add or update Playwright E2E tests for the verified flow; run them.
10. Run typecheck, lint, unit tests, and build if appropriate.
11. **Post-implementation critic round** — invoke the same Workflow again with
    `args.focus` set to the changed flow + `git diff`. Fix any remaining confirmed
    blockers (re-run the workflow until none remain).
12. Report final evidence.

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
