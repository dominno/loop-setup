---
description: Turn a described outcome into a production-grade, copy-pasteable /goal (or /loop) prompt for this project — grounded in CLAUDE.md, the memory wiki, and the verify gates. Use when starting a non-trivial task, or when asked to "write the /goal/loop for this".
argument-hint: [outcome in plain English, e.g. "add password reset" — say "loop" for a /loop]
---

Write the optimal **`/goal`** prompt (or a **`/loop`** prompt if asked) for the
described outcome. Do **not** start executing the task — your output is the prompt
the user will review, copy, and run.

Outcome / context:
$ARGUMENTS

## Procedure
1. Read `CLAUDE.md` (Main commands, completion gates, scope rules) and consult
   `.claude/memory/index.md` → the relevant topic page(s), so the prompt uses this
   project's **real** commands, conventions, and gates — not generic ones.
2. If the task is broad or unclear, ask 1–2 sharp clarifying questions first, or
   suggest running `/plan` and converting the plan into the goal.
3. Produce a single, copy-pasteable prompt in a fenced block, grounded in this repo.

## A `/goal` must include all six
1. **One-line task statement.**
2. **3–5 measurable success criteria** — objectively checkable and tied to this
   repo's gates (`pnpm verify` green, no blocking console errors, E2E covers the
   happy path + ≥1 failure path, no post-implementation critic blockers).
3. **Constraints** that hold throughout (scope limits, "don't touch X", no
   unrelated refactors, don't weaken or delete tests, don't push/deploy).
4. **Checkpoint rules** — when to pause for review vs. run straight through.
5. **Self-verify instruction** — run the relevant checks + a post-implementation
   critic round and report evidence (commands run, browser check, `git diff --stat`)
   before claiming done.
6. **Max-budget guard** — e.g. "stop after N turns if not achieved".

## Output template (fill in, don't echo verbatim)
```
/goal <one-line task statement>.

Success criteria (all must hold):
1. <measurable criterion>
2. <measurable criterion>
3. <measurable criterion>

Constraints: <scope limits; do-not-touch; no unrelated refactors; don't weaken tests>.
Checkpoints: <when to pause for review vs. run through>.
Self-verify: run <relevant checks> + a post-implementation critic round; report the
critic matrix, browser evidence, commands run, and `git diff --stat`.
Stop after <N> turns if not achieved.
```

For a `/loop`, instead frame it as recurring watchdog work (what to re-check each
iteration, what to fix vs. only report, when to stop) consistent with
`.claude/loop.md`.

Keep it production-grade and specific to this repo. End by telling the user they can
copy + run it, or ask you to adjust scope/criteria.
