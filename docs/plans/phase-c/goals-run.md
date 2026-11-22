# Phase C: one /goal that runs C3–C7

Paste the block below as a single `/goal` (it is under 4000 characters). It reads `goals.md` from the branch
`claude/blissful-galileo-akxz8w` until that file is on `main`.

```text
/goal Execute loop-setup phase-C goals C3, C4, C5, C6 and C7 in that order, exactly as specified in docs/plans/phase-c/goals.md.

Setup (first): run `git fetch origin claude/blissful-galileo-akxz8w`, then `git checkout FETCH_HEAD -- docs/plans/phase-c/goals.md docs/plans/phase-c/goals-run.md`, and commit both by pathspec, so the spec travels with the phase-C PR. If they are already on this branch, skip the fetch. Read the whole of goals.md before starting C3.

Success criteria (all must hold):
1. Every success criterion of C3, C4, C5, C6 and C7 in docs/plans/phase-c/goals.md holds on the final HEAD, each shown with the evidence that goal's Self-verify asks for.
2. Each goal ends at its own green checkpoint before the next one starts: its tests and the full chain pass; its post-implementation critic round ends with completion accept and no open blocker; its records are written; `loop-setup sync` is done; its commits are pushed.
3. C7's PR to main is open with green CI, and it is not merged.

Constraints: every goal's Pre-flight and Constraints in goals.md apply. In addition:
- Work strictly in order.
- Never start a goal while the previous one has an open blocker.
- Keep one running report section per goal (goal, commits, evidence, critic matrix, risks).

Checkpoints:
- Pause for my approval exactly where a goal says so: the designs in C3, C4 and C5.
- Pause when a critic blocker survives the fix-attempt bounds in CLAUDE.md.
- Pause when a pre-flight fails.
- Otherwise go straight from one goal to the next without waiting for me.

Self-verify: per goal, as written in goals.md. At the end, add a summary table (goal | status | commits | key evidence) and the PR link.

Budget: stop after 60 turns in total, or after 15 turns inside any one goal without meeting it. Then report what is done, what blocks, and which goal is next.
```
