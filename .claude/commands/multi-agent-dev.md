---
description: Full multi-agent critic-led development loop for a non-trivial feature, bug fix, or UI change; ends with browser + test evidence. The default for substantive work.
argument-hint: [task, e.g. "build the login page"]
---

Run a full multi-agent development loop for this local web app.

User task:
$ARGUMENTS

You are the Lead Agent. The critic rounds run as a **deterministic multi-agent
Workflow** (critics fan out as parallel subagents in their own contexts; every blocker,
and each important finding up to the round's verifier cap, is verified by a separate
skeptic) — **not** one agent simulating critics. Invoking the Workflow tool here is
expected (this command opts into multi-agent orchestration).

Procedure:

1. Read CLAUDE.md and package.json.
2. Inspect the relevant routes, components, API handlers, tests, and styles.
3. Start or reuse the local dev server; open the relevant localhost page (Chrome/
   Playwright MCP) and observe current behavior.
4. **Pre-implementation critic round** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/critic-panel.js`,
   `args: { "focus": "$ARGUMENTS (current behavior + changed files)", "priorRecords": <pnpm -s trace query --latest --writer critic-panel --brief>, "treeId": "<pnpm -s trace tree-id>" }`.
   When UI or perf lenses are in scope (a UI flow, or a change that can move the client
   bundle), first run `pnpm test:e2e` (including `e2e/a11y.spec.ts`) and
   `pnpm build && pnpm check:bundle` yourself and pass their output as `args.priorEvidence`:
   the critics and skeptics never run E2E, and never build or test in the shared checkout
   (their SAFETY rules), so a result you did not supply is reported as missing evidence.
   Save the exact args you launch with (`priorEvidence` included when you pass it) to a
   scratchpad file before launching: a round cut off by a limit or a kill resumes only with
   that file, verbatim (`docs/workflow-graphs.md` → *Running, watching and resuming*).
   Print `error` first if present (every lens failed, or `budgetStopped`: the token
   budget floor stopped the round before any reviewer started — no review happened), then
   `completion` (its claim next to `completion.verdict`, and its `missing`). Render the
   returned `confirmed` findings (verdict `accept`/`qualify`) as the critic matrix with
   their verdicts; list `deferred` (with `missing`) and `revised` (with `repair`), the
   cap-deferred findings among them too (`counts.capDeferred`, failedGates
   `not-verified:verifier-cap`: important findings past `args.maxVerifiers`, default 30,
   that no skeptic adjudicated); record `niceToHaves`; ignore `refuted`; if `error` is set
   (`budgetStopped` included) or `failedReviewers` is non-empty, say the round is
   incomplete and re-run it, and never CLEAR a record listed in
   `completion.notRechecked` (its lens was not reviewed). Record the verdicts exactly as
   the **consumer protocol** in `.claude/memory/topics/trace.md` says (save the result to
   a scratchpad file → `pnpm trace write <file>` → `pnpm trace act --from <file>`).
5. As Lead Agent, choose the smallest safe plan from the confirmed blockers +
   directly-related important findings. If the work is meant to run unattended through
   `/loop` instead, offer `/plan-nodes` (it turns the plan into confirmed loop-plan nodes) —
   never invoke it yourself. Act on a `qualify` finding only at its qualified
   strength (state the qualifier in your plan). A `deferred` or `revised` blocker is
   handled per the consumer protocol: gather its `missing` evidence (run the check,
   reproduce in the browser) or restate it per its `repair`, then re-adjudicate it in the
   next critic round (pass the evidence as `priorEvidence`) — never fix blind and never
   act on the defer itself. A cap-deferred important finding was never adjudicated: the
   next round verifies it (focus on it, or raise `args.maxVerifiers`) before you act on it.
6. Implement only those. Keep the **maker/checker split**: implementation is your
   pass; the post-implementation workflow below is the independent checker.
7. Run the smallest relevant automated checks first. For a bug fix, first add or adjust a
   test that fails on the bug and keep its failing output (write it before the step-6
   fix); the step-11 CLEAR note names the RED and the GREEN run.
8. Verify in browser on localhost; check console errors and failed network requests.
9. Add or update Playwright E2E tests for the verified flow; run them.
10. Run typecheck, lint, unit tests, and build if appropriate.
11. **Post-implementation critic round** — invoke the same Workflow again with
    `args.focus` set to the changed flow and `args.priorEvidence` set to what you
    already gathered (git diff summary + test/lint/build results + browser/console
    findings) so the critics verify against it instead of re-running everything.
    When UI or perf lenses are in scope, that evidence includes the output of
    `pnpm test:e2e` (including `e2e/a11y.spec.ts`) and `pnpm build && pnpm check:bundle`
    run on the tree this round reviews (step 10's build is then not optional), as in step 4.
    Pass `priorRecords` + a fresh `treeId` again (reuse only fires on an identical tree), and
    save these args, `priorEvidence` included, as in step 4.
    Fix any remaining blockers and re-run — at most **3** post-implementation rounds
    (infra re-runs of an incomplete round count toward the cap; at the cap, report the
    failed lenses and ask). **Stop re-running on diminishing returns:** when a complete
    round leaves the set of open blockers (by `claim_id`, confirmed + deferred + revised)
    and their verdicts unchanged, stop and report them **as they are** — never relabel a
    confirmed blocker as `defer` — and ask the user; the task stays incomplete. An
    incomplete round (`error` set, `budgetStopped` included, or a failed lens) is never
    diminishing returns: re-run it. For every finding the latest round no longer
    confirms *and* whose relevant check passes, append
    `pnpm trace act <record> multi-agent-dev CLEAR --note "<what showed it fixed>"` on its
    latest licensing record (for a bug fix the note names the RED and the GREEN run) —
    never on a record listed in `completion.notRechecked`, which that round did not
    review; for one you deliberately left, `HOLD` with a note.
12. Report final evidence.

Never mark complete unless:

- the flow works in browser
- no blocking console errors remain
- typecheck, lint, and unit tests pass (build passes when the change warrants it)
- relevant E2E tests pass
- post-implementation critic round has no blockers — its `completion.verdict` is
  `accept`: none confirmed, deferred or revised (an open defer/revise blocker keeps the
  task incomplete until it is re-adjudicated or the user explicitly accepts the risk)
- no reviewer failed in the final round (`failedReviewers` is empty, and
  `completion.missing` names no failed lens)
- no open blocker remains in the store beyond the round's view: `priorRecords` carries only
  the newest 40 records, so check
  `pnpm -s trace query --latest --writer critic-panel --severity blocker --json` (the latest
  blocker records only) for a `blocker` at accept/qualify/defer/revise with no CLEAR
  (`pnpm trace show <id>`)
- the round's TRACE records are appended (`pnpm trace lint` passes)
- files changed are reported
- remaining risks are listed

Do not push or deploy.
Do not delete tests.
Do not weaken assertions to pass.
Do not make unrelated refactors.
