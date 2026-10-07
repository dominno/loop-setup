---
description: Run the multi-agent critic round as a deterministic Workflow — critics fan out as parallel subagents (own context each), each blocker/important finding gets a typed TRACE verdict (accept/qualify/revise/defer/reject) from a separate skeptic, then a synthesized severity matrix is returned and its verdict records appended. Read-only on code.
argument-hint: [focus, e.g. "checkout flow on localhost"]
---

Run a **genuine multi-agent critic round** — not a single agent simulating critics.
Use the **Workflow tool** so each critic runs as its own subagent in its own context
and every blocker/important finding is verified by a *separate* skeptic.

Focus:
$ARGUMENTS

## Procedure
1. Make sure context exists for the critics: confirm `CLAUDE.md` and (if a UI flow
   is in scope) that localhost is running for the browser-driven critics.
2. **Gather the reuse inputs:** `pnpm -s trace query --latest --writer critic-panel --json`
   (prior verdicts) and `pnpm -s trace tree-id` (HEAD + uncommitted changes — reuse only
   fires when the code is identical).
3. **Invoke the Workflow tool** with the predefined critic-panel workflow:
   - `scriptPath: .claude/workflows/critic-panel.js`
   - `args: { "focus": "$ARGUMENTS", "priorRecords": <step-2 JSON>, "treeId": "<tree-id>" }`
   This command explicitly opts into multi-agent orchestration — calling Workflow
   here is expected.
4. The workflow returns `{ focus, treeId, counts, confirmed, deferred, revised, niceToHaves, refuted, traceRecords, reuseActions }`.
   Render `confirmed` (verdict `accept` or `qualify`) as the critic matrix and list
   `niceToHaves` separately:

   | Critic | Severity | Verdict | Finding | Evidence | Recommended action |
   |---|---|---|---|---|---|

   Show a `qualify` verdict with its qualifier (the strength the claim actually holds
   at). List `deferred` findings with their `missing` evidence and `revised` ones with
   their `repair` — neither is actionable as stated. Note `refuted` findings so they
   are not actioned. If `failedReviewers` is non-empty, say which lenses are missing —
   the round is incomplete.
5. **Record the verdicts** (memory, not code), per the consumer protocol in
   `.claude/memory/topics/trace.md`: save the workflow result JSON to a scratchpad file,
   then `pnpm trace write <file> --then-act HOLD --consumer critic-round --note
   "review-only round"` (records the verdicts and that this round acted on none of them)
   and `pnpm trace act --from <file>` (its `reuseActions`). If the writer rejects the
   batch, report the violations and do not hand-edit drafts. These records are what the
   next round reuses. Do **not** edit any other file — this is review only.

## Notes
- This is the heavier, deterministic path (the workflow spawns ~10 critic agents +
  one verifier per blocker/important finding, minus reused verdicts). That is intended:
  real independent review, not one context role-playing ten critics.
- Agreement between critics is **not** extra evidence (they share a model); only a
  critic bringing *different* evidence corroborates. Verdict semantics, the evidence
  standard per claim type, and the consumer actions: `.claude/memory/topics/trace.md`.
- Other commands (`/multi-agent-dev`, `/multi-agent-e2e`, `/qa-pass`) reuse this same
  workflow for their critic rounds.
