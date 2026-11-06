# Steps: planning & task-status upgrade

The persistent step list for this change (the `/multi-agent-dev` step-list shape: id,
description, scope, check, after, plus status and commit). One commit per step; the commit
column is filled from `git log` once a step lands. Spec: `04-spec.md`.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S00 | W0: L2 prerequisite (one logged L1 iteration) + *Not adopted (plan)* list | .claude/loop-checklist.md, .claude/memory/loop-plan.md, .claude/memory/topics/workflow.md | `vitest run scripts/template-docs.test.mjs` | — | planned | — |
| S01 | W1.1 attempt budget over every attempt (defers + revises) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S00 | planned | — |
| S02 | W1.2 transition table + `[unsupported-reset]` + human-release convention | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/memory/topics/trace.md | `vitest run scripts/trace/plan.test.mjs` | S01 | planned | — |
| S03 | W1.3 `[verified-unlanded]` detector | scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S02 | planned | — |
| S04 | W1.4 priority from origin severity | scripts/trace/plan.mjs, scripts/trace/cli.mjs | `vitest run scripts/trace/plan.test.mjs scripts/trace/cli.test.mjs` | S03 | planned | — |
| S05 | W2.1 `scope` and `check` columns | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace` | S04 | planned | — |
| S06 | W2.2 `[oversize]` + trust ceilings | scripts/trace/plan.mjs, .claude/loop-checklist.md | `vitest run scripts/trace/plan.test.mjs` | S05 | planned | — |
| S07 | W2.3 `plan-ready --batch N` (conflict-free by scope) | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/loop.md | `vitest run scripts/trace` | S05 | planned | — |
| S08 | W2.4 "done when" clause | scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S05 | planned | — |
| S09 | W3 split on failure (`dropped` + `split from`) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md, .claude/loop.md | `vitest run scripts/trace/plan.test.mjs` | S01, S05 | planned | — |
| S10 | W4.1 `/plan-nodes` command (+ /write-goal plan rows) | .claude/commands/plan-nodes.md, .claude/skills-index.md, .claude/commands/write-goal.md | `vitest run scripts/trace/config.test.mjs scripts/trace/workflows.test.mjs` | S05 | planned | — |
| S11 | W4.2 persistent `/multi-agent-dev` step list | .claude/commands/multi-agent-dev.md | `vitest run scripts/template-docs.test.mjs` | S10 | planned | — |
| S12 | W4.3/W4.4 story link `story:US-NNN#ACk` + `[story-dangling]` | scripts/trace/plan.mjs, scripts/trace/story-map.mjs, scripts/trace/cli.mjs, docs/stories/_TEMPLATE.md | `vitest run scripts/trace` | S05 | planned | — |
| S13 | W4.5 plan review gate (`[origin]`) | scripts/trace/plan.mjs, .claude/memory/loop-plan.md | `vitest run scripts/trace/plan.test.mjs` | S09, S10 | planned | — |
| S14 | W4.6 drift: CLEAR note `base; patch; check` + `pnpm trace plan-drift` | scripts/trace/cli.mjs, scripts/trace/plan.mjs, .claude/loop.md | `vitest run scripts/trace` | S05 | planned | — |
| S15 | W4.7 read-only `pnpm trace status` | scripts/trace/plan.mjs, scripts/trace/cli.mjs | `vitest run scripts/trace` | S12 | planned | — |
| S16 | W4.8 `reaudit --claim-prefix story:` | scripts/trace/cli.mjs, .claude/commands/sync-story-status.md | `vitest run scripts/trace/cli.test.mjs` | — | planned | — |
| S17 | M1 collision-free `LP-<hex>` ids + `pnpm trace plan-id` + `[duplicate-id]` after merge | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/memory/loop-plan.md | `vitest run scripts/trace` | S05 | planned | — |
| S18 | M2/M3/M5 owner-aware claims, commit+push lease, `[claim-conflict]` | scripts/trace/plan.mjs, scripts/trace/cli.mjs, .claude/loop.md | `vitest run scripts/trace` | S17 | planned | — |
| S19 | M4 `merge=union` for the append-only logs | .gitattributes | `vitest run scripts/trace/config.test.mjs` | — | planned | — |
| S20 | M6 merge-commit policy + CI reaudit warning | .github/workflows/verify.yml, scripts/trace/cli.mjs | `vitest run scripts/trace/cli.test.mjs` | — | planned | — |
| S21 | M7–M10 team docs: shared planning surface, story sync on main, /dream via PRs, "Working as a team" | docs/adoption-guide.md, .claude/commands/sync-story-status.md, .claude/commands/dream.md | `vitest run scripts/template-docs.test.mjs` | S18 | planned | — |
