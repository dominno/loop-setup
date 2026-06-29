---
description: Run the multi-agent critic round as a deterministic Workflow — critics fan out as parallel subagents (own context each), each blocker/important finding is adversarially verified by a separate skeptic, then a synthesized severity matrix is returned. Read-only; changes no code.
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
2. **Invoke the Workflow tool** with the predefined critic-panel workflow:
   - `scriptPath: .claude/workflows/critic-panel.js`
   - `args: { "focus": "$ARGUMENTS" }`
   This command explicitly opts into multi-agent orchestration — calling Workflow
   here is expected.
3. The workflow returns `{ focus, counts, confirmed, niceToHaves, refuted }`.
   Render `confirmed` as the critic matrix and list `niceToHaves` separately:

   | Critic | Severity | Finding | Evidence | Recommended action |
   |---|---|---|---|---|

4. Note any `refuted` findings (a skeptic could not substantiate them) so they are
   not actioned. Do **not** edit files — this is review only.

## Notes
- This is the heavier, deterministic path (the workflow spawns ~10 critic agents +
  one verifier per blocker/important finding). That is intended: real independent
  review, not one context role-playing ten critics.
- Other commands (`/multi-agent-dev`, `/multi-agent-e2e`, `/qa-pass`) reuse this same
  workflow for their critic rounds.
