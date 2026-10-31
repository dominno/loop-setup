---
description: Run the multi-agent critic round as a deterministic Workflow — critics fan out as parallel subagents (own context each; a code-only round uses one all-lens reviewer), every blocker and each important finding up to a verifier cap gets a typed TRACE verdict (accept/qualify/revise/defer/reject) from a separate skeptic, then a synthesized severity matrix is returned and its verdict records appended. Read-only on code.
argument-hint: [focus, e.g. "checkout flow on localhost"]
---

Run a **genuine multi-agent critic round** — not a single agent simulating critics.
Use the **Workflow tool** so each critic runs as its own subagent in its own context
and every blocker (and each important finding up to the round's verifier cap) is verified
by a *separate* skeptic. (One measured exception: a code-only round, `uiInScope: false`,
runs one all-lens reviewer — see Notes.)

Focus:
$ARGUMENTS

## Procedure
1. Make sure context exists for the critics: confirm `CLAUDE.md` and (if a UI flow
   is in scope) that localhost is running for the browser-driven critics. When UI or perf
   lenses are in scope (a UI flow, or a change that can move the client bundle), run
   `pnpm test:e2e` (including `e2e/a11y.spec.ts`) and `pnpm build && pnpm check:bundle`
   yourself first and pass their output as `priorEvidence` (step 3), as `/qa-pass` does:
   the critics and skeptics never run E2E, and never build or test in the shared checkout
   (their SAFETY rules), so a result you did not supply is reported as missing evidence.
2. **Gather the reuse inputs:** `pnpm -s trace query --latest --writer critic-panel --brief`
   (prior verdicts) and `pnpm -s trace tree-id` (HEAD + uncommitted changes — reuse only
   fires when the code is identical).
3. **Invoke the Workflow tool** with the predefined critic-panel workflow:
   - `scriptPath: .claude/workflows/critic-panel.js`
   - `args: { "focus": "$ARGUMENTS", "priorRecords": <step-2 JSON>, "treeId": "<tree-id>" }`,
     plus `"priorEvidence": "<the step-1 output>"` when UI or perf lenses are in scope
   This command explicitly opts into multi-agent orchestration — calling Workflow
   here is expected.
4. The workflow returns `{ error?, budgetStopped?, focus, treeId, reviewMode, failedReviewers, completion, counts, confirmed, deferred, revised, niceToHaves, refuted, traceRecords, reuseActions }`.
   **Print first:** `error` if present (every lens failed, or `budgetStopped`: the token
   budget floor stopped the round before any reviewer started — either way no review
   happened, re-run), then `completion` — its claim next to `completion.verdict`, its
   `missing`, and `notRechecked`. The round is clean only when `completion.verdict` is
   `accept`; `reject` means a blocker is confirmed, `defer` that the round is incomplete
   or a blocker is still open (Round integrity in `.claude/memory/topics/trace.md`). Then
   render `confirmed` (verdict `accept` or `qualify`) as the critic matrix and list
   `niceToHaves` separately:

   | Critic | Severity | Verdict | Finding | Evidence | Recommended action |
   |---|---|---|---|---|---|

   Show a `qualify` verdict with its qualifier (the strength the claim actually holds
   at). List `deferred` findings with their `missing` evidence and `revised` ones with
   their `repair` — neither is actionable as stated. The deferred list includes the
   cap-deferred findings (`counts.capDeferred`, failedGates `not-verified:verifier-cap`):
   no skeptic adjudicated them, so list them too. Note `refuted` findings so they
   are not actioned. If `failedReviewers` is non-empty, say which lenses are missing —
   the round is incomplete; re-run it. Never CLEAR a record listed in
   `completion.notRechecked` on this round's evidence: its lens was not reviewed.
5. **Record the verdicts** (memory, not code), per the consumer protocol in
   `.claude/memory/topics/trace.md`: save the workflow result JSON to a scratchpad file,
   then `pnpm trace write <file> --then-act HOLD --consumer critic-round --note
   "review-only round"` (records the verdicts and that this round acted on none of them)
   and `pnpm trace act --from <file>` (its `reuseActions`). If the writer rejects the
   batch, report the violations and do not hand-edit drafts. These records are what the
   next round reuses. Do **not** edit any other file — this is review only.

## Notes
- This is the heavier, deterministic path (the workflow spawns ~10 critic agents +
  one verifier per blocker and per important finding up to `args.maxVerifiers`, minus
  reused verdicts). That is intended: real independent review, not one context
  role-playing ten critics.
- Cost bounds. `args.maxVerifiers` (default 30) caps the skeptics a round starts: every
  blocker is verified regardless, important findings fill the slots left (round-robin
  across lenses), and the rest come back in `deferred` with failedGates
  `not-verified:verifier-cap` and `counts.capDeferred` set — listed, never dropped, never
  actioned. A defer is never reused, so the next round verifies them; re-run focused on
  them or raise the cap. With a `+Nk` token target, a round started under 80k tokens left
  returns `error` and `budgetStopped` with every in-scope lens in `failedReviewers`: an
  incomplete round (re-run it with more budget, never read it as clean). A round that
  reaches Verify under 60k left starts no skeptic: every fresh blocker and important
  finding is deferred with failedGates `not-verified:budget`, so a blocker among them keeps
  `completion.verdict` at `defer`.
- Exception, measured: a code-only round (`uiInScope: false` — no browser lens in scope)
  runs ONE all-lens reviewer instead of the critic fan-out (`reviewMode: 'single-pass'`):
  TRACE-Bench-lite found it as good as the panel on code-only review at ~5x lower cost
  (F1; qualified: one run on the 19-fixture bench, 5 of the 10 critics, measured as diff-level block/no-block with the bench's own single-pass prompt — not this round's production prompt). Each finding still names its lens; every blocker, and each
  important finding up to the verifier cap, gets a typed verdict from a separate skeptic,
  and the rest are recorded as defers. Pass `reviewMode: 'panel'` to force the fan-out.
- `completion` sees only the prior records passed in, and `--brief` carries the newest 40.
  Before a task is declared complete, also check the whole store for an open blocker:
  `pnpm -s trace query --latest --writer critic-panel --json` lists each latest critic
  record with its `severity`; a `blocker` at accept/qualify/defer/revise is open unless
  `pnpm trace show <id>` lists a CLEAR on it.
- Agreement between critics is **not** extra evidence (they share a model); only a
  critic bringing *different* evidence corroborates. Verdict semantics, the evidence
  standard per claim type, and the consumer actions: `.claude/memory/topics/trace.md`.
- Other commands (`/multi-agent-dev`, `/qa-pass`, `/loop`) reuse this same
  workflow for their critic rounds.
