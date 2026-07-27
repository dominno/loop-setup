# Loop Plan — the DAG every loop action traces to

The loop's **durable, mutable plan**: an ordered set of typed work nodes with explicit
`after:` dependency edges. This is the HTDAG "no action without a plan node" surface —
every L2/L3 fix the loop dispatches must correspond to a **ready node** here.

This is **distinct from `loop-run-log.md`**:
- `loop-plan.md` (this file) = the *current* plan — what remains, mutable, re-planned each iteration.
- `loop-run-log.md` = append-only *history* — what happened, never rewritten.

> Not `@imported`, so it costs nothing until a loop opens it. The loop reads it at
> iteration start (step 1) and rewrites it in the re-plan step (see `.claude/loop.md`).

## Node schema
One row per node in the table below:

| Field | Meaning |
|---|---|
| `id` | Stable node id, `LP-NNN` (never reused after `done`/`dropped`). |
| `description` | One line — the bounded unit of work. |
| `after` | Comma-separated `id`s this node depends on; empty = no deps. |
| `status` | `ready` · `blocked` · `in-progress` · `done` · `escalated` · `dropped`. |
| `origin` | Where it came from: a confirmed critic finding, a re-plan, or a human. |
| `notes` | Evidence / decision trail (attempt count, escalation reason). |

**Status meaning**
- `ready` — all `after:` deps are `done`; eligible for dispatch this iteration.
- `blocked` — has an unmet `after:` dep (compute, don't hand-set, when deps are open).
- `in-progress` — dispatched to the loop-iteration Workflow this iteration.
- `done` — implemented **and** verified by the separate checker; deps unblock.
- `escalated` — handed to a human (denylist hit, max attempts, ambiguity).
- `dropped` — obsoleted by re-plan; kept as a row for the decision trail.

## Ready-node rule (what the loop dispatches next)
A node is **ready** iff `status ∉ {done, dropped, escalated}` **and** every `id` in its
`after:` is `done`. The loop picks the highest-priority ready node (topmost first).
Denylist and trust-level gates still apply **on top** of readiness — a ready node whose
fix would touch a denylist path is escalated, never auto-applied.

## No action without a node
Every L2/L3 dispatch (`loop-iteration.js` `args.items`) MUST be ready nodes from this
table — each item's `id` is its node `id`. An action with no backing node is **not
taken**; instead the re-plan step creates the node first (see below). Node creation is
the *only* loop action not itself gated by an existing node — it is the sanctioned way
to bootstrap, so an empty plan never deadlocks:

- **Empty / first-iteration plan:** after triage, the re-plan step creates nodes from
  this run's *confirmed* findings, then dispatch acts on the now-ready nodes. If triage
  + re-plan yield zero ready nodes, the loop **self-stops** (empty-watchlist rule in
  `loop.md`) — it does not invent work.

## Example (illustrative — not a live row)
```
| LP-001 | Fix hydration warning on /             | —      | done        | critic:frontend | verified 2026-… |
| LP-002 | Add E2E for the cleared-name path      | LP-001 | ready       | critic:qa       |                 |
| LP-003 | Rework auth token refresh              | —      | escalated   | critic:security | denylist: auth  |
```

## Plan
_No nodes yet. The first L2/L3 loop run bootstraps nodes here from its confirmed
findings during the re-plan step._

| id | description | after | status | origin | notes |
|---|---|---|---|---|---|
