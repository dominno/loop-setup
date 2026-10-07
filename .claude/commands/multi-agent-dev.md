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
   `repair`); record `niceToHaves`; ignore `refuted`; if `failedReviewers` is non-empty,
   say the round is incomplete and re-run it. Record the verdicts exactly as the
   **consumer protocol** in `.claude/memory/topics/trace.md` says (save the result to a
   scratchpad file → `pnpm trace write <file>` → `pnpm trace act --from <file>`).
5. As Lead Agent, choose the smallest safe plan from the confirmed blockers +
   directly-related important findings. Act on a `qualify` finding only at its qualified
   strength (state the qualifier in your plan). A `deferred` or `revised` blocker is
   handled per the consumer protocol: gather its `missing` evidence (run the check,
   reproduce in the browser) or restate it per its `repair`, then re-adjudicate it in the
   next critic round (pass the evidence as `priorEvidence`) — never fix blind and never
   act on the defer itself.
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
    Pass `priorRecords` + a fresh `treeId` again (reuse only fires on an identical tree).
    Fix any remaining blockers and re-run — at most **3** post-implementation rounds.
    **Stop re-running on diminishing returns:** when a round leaves the set of open
    blockers (by `claim_id`, confirmed + deferred + revised) and their verdicts unchanged,
    stop and report them **as they are** — never relabel a confirmed blocker as `defer` —
    and ask the user; the task stays incomplete. For every finding the latest round no
    longer confirms *and* whose relevant check passes, append
    `pnpm trace act <record> multi-agent-dev CLEAR --note "<what showed it fixed>"` on its
    latest licensing record; for one you deliberately left, `HOLD` with a note.
12. Report final evidence.

Never mark complete unless:

- the flow works in browser
- no blocking console errors remain
- typecheck, lint, and unit tests pass (build passes when the change warrants it)
- relevant E2E tests pass
- post-implementation critic round has no blockers — none confirmed, deferred or revised
  (an open defer/revise blocker keeps the task incomplete until it is re-adjudicated or
  the user explicitly accepts the risk)
- no reviewer failed in the final round (`failedReviewers` is empty)
- the round's TRACE records are appended (`pnpm trace lint` passes)
- files changed are reported
- remaining risks are listed

Do not push or deploy.
Do not delete tests.
Do not weaken assertions to pass.
Do not make unrelated refactors.
