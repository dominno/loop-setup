---
description: Design and run Playwright E2E tests for a user flow — a multi-agent workflow enumerates cases per path category (happy, failure, edge, accessibility, regression), a separate judge types each one, and only the licensed cases are implemented. Use when a flow needs new or expanded E2E coverage.
argument-hint: [target flow, e.g. "onboarding"]
---

Design and run E2E tests using a **deterministic multi-agent Workflow**: one agent per
path category enumerates cases in its own context, then a separate judge agent types each
deduped case (a TRACE verdict held to the evidence gate), so the agents that propose a
case never license it. It is enumeration plus a judge, not a critic panel: the new specs
get a real critic round after implementation (step 7).

Target flow:
$ARGUMENTS

Procedure:

1. Inspect existing Playwright tests, app routes, and components.
2. Start or reuse localhost; manually verify the target flow in browser.
3. **Enumerate and judge test cases via a Workflow** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/e2e-design.js`, `args: { "flow": "$ARGUMENTS" }`.
   One agent per path category (happy, failure, edge, accessibility, regression)
   enumerates concrete cases in its own context; results are deduped, and a separate
   judge returns one typed verdict per case under the visible-outcome rule
   (`docs/e2e-coverage-map.md`: a test must assert a visible outcome, not just page load).
   A deterministic evidence gate settles each verdict as a factual claim: an `accept` or
   `qualify` citing only `reading` becomes `defer`. (Invoking Workflow here is expected.)
   It returns `{ error?, flow, judged, count, cases, covered, revised, deferred, rejected, failedCategories, verdictCounts }`
   and no `traceRecords`: the verdicts are advisory and change no durable state.
   - **Print first:** `error` if present. Every category agent failed (infra), so no case
     was designed or judged: report it and re-run. Then print `judged` and `verdictCounts`.
   - `judged: false` with deferred cases means no live judge verdict: the judge failed
     (failedGates `agent-failed`: re-run) or the token budget floor skipped it
     (`not-verified:budget`: re-run with more budget). Implement nothing from such a run.
   - Name any `failedCategories`: those path categories were not enumerated (never read
     them as "no cases"), so list them under remaining coverage gaps.
   - `verdictCounts` that show every case accepted means the judge changed nothing: check
     a sample of its evidence before you rely on the run.
4. Implement Playwright tests from the returned `cases` only (verdict `accept` or
   `qualify`; keep a `qualify` case within its `qualifier`). Cover the happy path + at least
   one failure/edge path; run the specific specs.
   - A `revised` case's `repair` is a new claim, not a licensed case: implement it only as
     a new case, and let the post-implementation round (step 7) adjudicate it.
   - Never implement a `deferred` case as it stands: supply its `missing` evidence and
     re-run the workflow.
   - `covered` cases are already asserted by an existing spec (`coveredBy` names its
     file:line). A `rejected` case with `duplicateOf` duplicates a case returned in `cases`;
     one without it is unobservable as stated.
5. Fix test or app failures, but do not weaken assertions.
6. Run browser verification again.
7. **Post-implementation critic round** on the new specs — invoke the Workflow tool with
   `scriptPath: .claude/workflows/critic-panel.js` and
   `args: { "focus": "<the new or changed spec files>", "uiInScope": false, "priorEvidence": "<git diff summary + the step-4 spec runs' output>", "priorRecords": <pnpm -s trace query --latest --writer critic-panel --brief>, "treeId": "<pnpm -s trace tree-id>" }`.
   This is a code-only round: one all-lens reviewer, and every blocker (and each important
   finding up to the verifier cap) gets a typed verdict from a separate skeptic. The
   critics and skeptics never run E2E or build in the shared checkout (their SAFETY
   rules), so pass the spec runs yourself. If step 5 changed app code, that change is a
   product change: review it in a round with its UI lenses in scope, as `/critic-round`
   describes. Print `error` first if present (no review happened), then `completion` (its
   claim next to `completion.verdict`, and its `missing`); on `error` or a non-empty
   `failedReviewers` the round is incomplete, so re-run it. The work is done only when
   `completion.verdict` is `accept`: fix a confirmed blocker and re-run; supply a deferred
   blocker's `missing` evidence, or adjudicate a revised blocker's `repair`, in the next
   round. Record the verdicts per the **consumer protocol** in
   `.claude/memory/topics/trace.md` (scratchpad file → `pnpm trace write <file>` →
   `pnpm trace act --from <file>`).
8. Report evidence.

Required output:

- E2E cases added
- browser flow verified
- commands run
- failures found
- files changed
- the judge's `verdictCounts`, and the critic round's `completion.verdict`
- remaining coverage gaps: every `deferred` case (with its `missing`), every `revised`
  case (with its `repair`, and whether you implemented it as a new case), every `rejected`
  case without `duplicateOf` (unobservable as stated), and every `failedCategories` entry.
  `covered` cases and duplicate rejects are not gaps.
