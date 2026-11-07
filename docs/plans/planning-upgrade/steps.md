# Steps: planning & task-status upgrade

The persistent step list for this change (the `/multi-agent-dev` step-list shape: id,
description, scope, check, after, plus status and commit). One commit per step; the commit
column is filled from `git log` once a step lands. Spec: `04-spec.md`.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S00 | W0: L2 prerequisite (one logged L1 iteration) + *Not adopted (plan)* list | .claude/loop-checklist.md, .claude/memory/loop-plan.md, .claude/memory/topics/workflow.md | `vitest run scripts/template-docs.test.mjs` | — | done | 39be216 |
| S01 | W1.1 attempt budget over every attempt (defers + revises) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S00 | done | 5970a69 |
| S02 | W1.2 transition table + `[unsupported-reset]` + human-release convention | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/memory/topics/trace.md | `vitest run scripts/trace/plan.test.mjs` | S01 | done | a5ea643 |
| S03 | W1.3 `[verified-unlanded]` detector | scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S02 | done | 5d7657f |
| S04 | W1.4 priority from origin severity | scripts/trace/plan.mjs, scripts/trace/cli.mjs | `vitest run scripts/trace/plan.test.mjs scripts/trace/cli.test.mjs` | S03 | done | 129bfe2 |
| S05 | W2.1 `scope` and `check` columns | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace` | S04 | done | 29d2119 |
| S06 | W2.2 `[oversize]` + trust ceilings | scripts/trace/plan.mjs, .claude/loop-checklist.md | `vitest run scripts/trace/plan.test.mjs` | S05 | done | 5631e6e |
| S07 | W2.3 `plan-ready --batch N` (conflict-free by scope) | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/loop.md | `vitest run scripts/trace` | S05 | done | 2d51317 |
| S07.1 | Critic-round fix: brace/bracket scope globs fail closed; braces never split the scope cell | scripts/trace/plan.mjs | `vitest run scripts/trace/plan.test.mjs` | S07 | done | d7ceb47 |
| S08 | W2.4 "done when" clause | scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S05 | done | 4205cbf |
| S09 | W3 split on failure (`dropped` + `split from`) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S01, S05 | done | 0a8d19c |
| S09.1 | Critic-round fix: `split into` ids end at a word boundary (hex ids like LP-123abc) | scripts/trace/plan.mjs | `vitest run scripts/trace/plan.test.mjs` | S09 | done | b43596f |
| S10 | W4.1 `/plan-nodes` command (+ /write-goal plan rows) | .claude/commands/plan-nodes.md, .claude/skills-index.md, .claude/commands/write-goal.md | `vitest run scripts/trace/config.test.mjs scripts/trace/workflows.test.mjs` | S05 | done | e4eca71 |
| S11 | W4.2 persistent `/multi-agent-dev` step list | .claude/commands/multi-agent-dev.md | `vitest run scripts/template-docs.test.mjs` | S10 | done | ffce330 |
| S12 | W4.3/W4.4 story link `story:US-NNN#ACk` + `[story-dangling]` | scripts/trace/plan.mjs, scripts/trace/story-map.mjs, scripts/trace/cli.mjs, docs/stories/_TEMPLATE.md | `vitest run scripts/trace` | S05 | done | 359a11c |
| S13 | W4.5 plan review gate (`[origin]`) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md | `vitest run scripts/trace/plan.test.mjs` | S09, S10 | done | 7ca2306 |
| S14 | W4.6 drift: CLEAR note `base; patch; check` + `pnpm trace plan-drift` | scripts/trace/cli.mjs, scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace` | S05 | done | 5aec9d5 |
| S15 | W4.7 read-only `pnpm trace status` | scripts/trace/plan.mjs, scripts/trace/cli.mjs | `vitest run scripts/trace` | S12 | done | affb8c4 |
| S16 | W4.8 `reaudit --claim-prefix story:` | scripts/trace/cli.mjs, .claude/commands/sync-story-status.md | `vitest run scripts/trace/cli.test.mjs` | — | done | ab3bfbe |
| S17 | M1 collision-free `LP-<hex>` ids + `pnpm trace plan-id` + `[duplicate-id]` after merge | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/memory/loop-plan.md | `vitest run scripts/trace` | S05 | done | 9f128dd |
| S18 | M2/M3/M5 owner-aware claims, commit+push lease, `[claim-conflict]` | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/loop.md | `vitest run scripts/trace` | S17 | done | d41008b |
| S19 | M4 `merge=union` for the append-only logs | .gitattributes | `vitest run scripts/trace/config.test.mjs` | — | done | 1d2f7bd |
| S20 | M6 merge-commit policy + CI reaudit warning | .github/workflows/verify.yml, scripts/trace/cli.mjs | `vitest run scripts/trace/cli.test.mjs` | — | done | 1db1137 |
| S21 | M7–M10 team docs: shared planning surface, story sync on main, /dream via PRs, "Working as a team" | docs/adoption-guide.md, .claude/commands/sync-story-status.md, .claude/commands/dream.md | `vitest run scripts/template-docs.test.mjs` | S18 | done | eaccaa7 |
| S21.1 | How-to guide `docs/planning-guide.md` + infographic 5 (SVG source, PNG) linked from README | docs/planning-guide.md, docs/infographic-5-planning.svg, docs/infographic-5-planning.png, README.md | `vitest run scripts/template-docs.test.mjs` | S21 | done | (see git log) |

Notes (decisions recorded with the user during the run):
- **W0 vs. 100%:** the W0 qualifier would postpone new plan-lint errors and columns until one
  logged L1 run; the user chose the full scope now. The W0 gate itself (an L1 run before L2)
  is in `loop-checklist.md`.
- **Split at L3:** the qualifiers say escalate instead of splitting at L3 until
  `/bench-checkers` measured split nodes; the user chose that stricter reading over the spec's
  "allowed at L3 once tests pass".
- **M6 CI change:** approved by the user (a warn-only `provenance` job).
- **`/plan` → `/plan-nodes`:** Claude Code's built-in `/plan` owns that name.
- **`[scope]`, `[done-when]`, `[oversize]`, `[check]`, `[origin]`** run under `--pre-dispatch`
  (dispatch-time rules), so a plan between iterations lints without them.
