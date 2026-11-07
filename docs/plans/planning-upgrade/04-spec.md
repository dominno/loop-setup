# Spec: planning & task-status upgrade (full scope, not a pilot)

Sources: 01-research.md (web patterns), 02-council-findings.md (26 adjudicated proposals —
the skeptic's repair/qualifier is binding), 03-multi-developer.md (M1–M10).
Design rule from the council: extend the existing markdown DAG + TRACE discipline; do NOT adopt
a JSON plan, an epic/parent container hierarchy, a numeric complexity score or new node statuses.

## Global rules
- New branch from current `main` (the previous PR is merged). One commit per work item, by
  pathspec; never rewrite pushed history.
- TDD: each rule gets a failing test first (plan.test.mjs, story-map.test.mjs, cli.test.mjs,
  template-docs.test.mjs, workflows.test.mjs as fits), then the change.
- Every existing gate stays green and is never weakened: plan-lint, story-lint, wiki-check,
  trace lint, contracts/parity tests, loop denylist, `pnpm verify`.
- Never edit `<loop-verifier>`. If the plan-items item shape or any verifier-visible text changes,
  stop: that needs `/bench-checkers` (repeat ≥ 2) before L3 — record it, do not run it unasked.
- Back-compat: existing `loop-plan.md` rows and legacy `LP-NNN` ids stay valid; new columns are
  optional (`—` allowed) unless a rule below makes them required for a `ready` node.
- Docs that describe a changed rule (loop-plan.md schema, loop.md steps, loop-checklist.md,
  trace.md, adoption guide, README, skills-index) change in the same item; drift tests extended.

## W0 Prerequisite (pragmatism critic, revised)
- loop-checklist.md: before L2, at least one L1 iteration logged in loop-run-log.md with a re-plan
  delta and `plan-lint --pre-dispatch` passing on a non-empty plan. Document it; add a template-docs anchor.

## W1 Status integrity (cheap, no schema change)
1. **Attempt budget over every attempt** (accepted): defers, failed post-apply checks and revise
   records all count; plan-lint `[attempts]` fails a live node past the budget that is not escalated.
2. **Transition rules** (revised): prose transition table in loop-plan.md; plan-lint state rules,
   incl. `[unsupported-reset]` (a node may not return to ready/blocked while its cited record is
   escalation-grade). No `--base` diff mode.
3. **Verified-but-unlanded detector** (qualified): `[verified-unlanded]` warning; resume only per
   the qualifier (saved diff path exists, HEAD == record headSha, all apply checks still run).
4. **Priority from origin severity** (qualified): blocker < important < other/human, table order breaks ties.

## W2 Node contract and size
1. **`scope` and `check` columns** (revised): empty `check` on a ready node = error under
   `--pre-dispatch`; empty `scope` = warning; step 10's same-file exclusion and dirty-file skip read
   `scope`. Lead-side only: plan-items item shape unchanged.
2. **Size from scope** (revised): no `size` column; `[oversize]` fails `--pre-dispatch` when a ready
   node's scope lists > 3 paths → split or escalate; trust ceilings in loop-checklist.md (L3: ≤ 1-file
   scope; L2: ≤ 3).
3. **`touches` + conflict-free batch** (revised): `plan-ready --batch N` picks a greedy
   non-overlapping set by `scope`; an empty scope dispatches alone (fail closed).
4. **"done when" clause** (qualified): re-plan writes `done when: …` from the origin finding's
   evidence/fix into the description; warning when absent.

## W3 Decomposition on failure (ADaPT, existing statuses)
- Split convention in loop-plan.md + loop.md step 9 (merge the three revised proposals): only for
  a node whose own `loop:<id>` revise has a non-empty repair, a post-apply check failure, or a defer
  naming scope; parent → `dropped` with `split into …`; children `origin: split from LP-x` citing the
  triggering record; dependents re-pointed to all children (or a chained last child); plan-lint
  validates split ancestry; L2 only at first per the qualifier — then allowed at L3 once tests pass.

## W4 Planning flow, traceability and visibility
1. **`/plan` command** (qualified): story/spec → proposed nodes with scope, check, after, story
   link; each node appended only after user confirmation; skills-index row; not auto-invoked by
   /multi-agent-dev or /write-goal (they offer it).
2. **Persistent step list for /multi-agent-dev** (revised): fixed shape (id, description, scope,
   check, after) under `docs/plans/<slug>/steps.md`; follow-ups become children, not ad-hoc ids.
3. **Story link** (revised/qualified): optional `story` token `US-NNN#ACk` (column or in origin);
   plan-lint `[story-dangling]` (story ids passed in by cli.mjs, plan.mjs stays pure); story-lint
   lists open nodes per story as a warning; plan and story statuses never move each other.
4. **Requirement/verify link** (revised): covered by `check` + story token; no extra columns.
5. **Plan review gate** (revised): plan-lint rule that a live node's origin cites an accept/qualify
   critic record, a valid `cascade/split from`, a `/plan`-confirmed entry, or a human.
6. **Drift and node↔commit linkage** (revised): CLEAR note carries `base <sha>; patch <hash>; <check>`;
   optional `Plan: LP-…` commit trailer (never a lint error).
7. **`pnpm trace status`** (qualified): read-only rollup (per status, per story, claims/age,
   oversize, attempts) labelled "consistency, not truth"; never evidence in a record.
8. **Story stale-evidence**: `pnpm trace reaudit --claim-prefix story:` used first by /sync-story-status.

## W5 Multi-developer (03-multi-developer.md M1–M10)
- M1 collision-free ids + `[dup-id]`; M2 owner-aware claims (`claim:<owner>@<run-id>`), never reset
  another owner's node; M3 claim via commit+push lease, documented; M4 `merge=union` for
  loop-run-log.md and memory log.md; M5 `[claim-conflict]`; M6 merge-commit policy + CI reaudit
  warning; M7 shared planning surface; M8 story-sync on main; M9 /dream via PRs; M10 adoption-guide
  "Working as a team" section. Claims also satisfy the status-model "claim ownership" proposal.

## Definition of done
All W0–W5 items implemented or, where a binding qualifier forbids part of it, the reason recorded
in the PR; `pnpm verify` green; a post-implementation critic round (critic-panel, code-only) with no
open blocker and its records written; `/dream` ingest of durable facts; a PR from the new branch
with a merge-commit note.
