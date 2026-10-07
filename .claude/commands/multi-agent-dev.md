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
   `args: { "focus": "$ARGUMENTS (current behavior + changed files)", "priorRecords": <pnpm -s trace query --latest --writer critic-panel --json>, "treeId": "<pnpm -s trace tree-id>" }`.
   Render the returned `confirmed` findings (verdict `accept`/`qualify`) as the critic
   matrix with their verdicts; list `deferred` (with `missing`) and `revised` (with
   `repair`); record `niceToHaves`; ignore `refuted`. Append the verdicts with
   `pnpm trace write -` / `pnpm trace act --from -` (TRACE records — see
   `.claude/memory/topics/trace.md`).
5. As Lead Agent, choose the smallest safe plan from the confirmed blockers +
   directly-related important findings. Act on a `qualify` finding only at its
   qualified strength; for a `deferred` blocker, first gather its `missing` evidence
   (run the check, reproduce in the browser) rather than fixing blind.
6. Implement only those. Keep the **maker/checker split**: implementation is your
   pass; the post-implementation workflow below is the independent checker.
7. Run the smallest relevant automated checks first.
8. Verify in browser on localhost; check console errors and failed network requests.
9. Add or update Playwright E2E tests for the verified flow; run them.
10. Run typecheck, lint, unit tests, and build if appropriate.
11. **Post-implementation critic round** — invoke the same Workflow again with
    `args.focus` set to the changed flow and `args.priorEvidence` set to what you
    already gathered (git diff summary + test/lint/build results + browser/console
    findings) so the critics verify against it instead of re-running everything.
    Pass `priorRecords` + a fresh `treeId` again (reuse only fires on an identical tree). Fix any
    remaining confirmed blockers and re-run until none remain — **but stop on
    diminishing returns**: if a re-run produces no new evidence (no new record, no
    verdict change), stop re-running and report the remaining blockers as `defer` with
    their `missing` instead of spinning. For every finding you fixed, append
    `pnpm trace act <record> multi-agent-dev CLEAR`; for one you deliberately left,
    `HOLD` with a note.
12. Report final evidence.

Never mark complete unless:

- the flow works in browser
- no blocking console errors remain
- typecheck, lint, and unit tests pass (build passes when the change warrants it)
- relevant E2E tests pass
- post-implementation critic round has no confirmed blockers (and every remaining
  `deferred` blocker names its `missing` evidence in the report)
- the round's TRACE records are appended (`pnpm trace lint` passes)
- files changed are reported
- remaining risks are listed

Do not push or deploy.
Do not delete tests.
Do not weaken assertions to pass.
Do not make unrelated refactors.
