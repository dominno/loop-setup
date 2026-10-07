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
| `status` | `ready` · `blocked` · `in-progress` · `deferred` · `done` · `escalated` · `dropped`. |
| `record` | The TRACE-lite `record_id` behind the node's latest status change (`pnpm trace show <id>`); empty only while `ready`/`blocked` with no verdict yet. |
| `missing` | For `deferred`/`escalated`: the evidence or decision that would unblock it — the record's `missing`, else its `repair`, else "a human decision on: <its reason>". Never empty. |
| `origin` | Where it came from: a confirmed critic finding (cite its record id), a re-plan, or a human. |
| `notes` | Evidence / decision trail (attempt count, escalation reason). |

**Status meaning**
- `ready` — all `after:` deps are `done`; eligible for dispatch this iteration.
- `blocked` — has an unmet `after:` dep (compute, don't hand-set, when deps are open).
- `in-progress` — dispatched to the loop-iteration Workflow this iteration. If the
  workflow returns `error`/`budgetStopped` (no verdict exists), the node reverts to `ready`
  in the same iteration — never `escalated`.
- `deferred` — the checker returned TRACE `defer`: the fix could not be judged yet, and the
  record names what is `missing` (a check it could not see, a dependency landing, a
  re-verify). **Resolvable by the loop itself** — see *Deferred nodes* below.
- `done` — implemented **and** verified by the separate checker; deps unblock. Requires a
  `record` written by the **loop-iteration verifier for this node** (`claim_id
  loop:<node id>`) whose verdict is `accept`/`qualify`, **and** a `CLEAR` action on it
  citing the post-apply check (no durable state change without a record —
  `.claude/memory/topics/trace.md`). Re-plan never sets `done` by itself.
- `escalated` — handed to a human (denylist hit, max attempts, ambiguity, a `reject`/
  `revise` verdict, or a `defer` whose `missing` is a human approval — the loop cannot
  resolve those, so they are escalated, not deferred); its `missing` names the human
  decision needed.
- `dropped` — obsoleted by re-plan; kept as a row for the decision trail.

## Ready-node rule (what the loop dispatches next)
A node is **ready** iff `status ∉ {done, dropped, escalated, in-progress, deferred}` **and**
every `id` in its `after:` is `done`. The loop picks the highest-priority ready node (topmost
first). Denylist and trust-level gates still apply **on top** of readiness — a ready node
whose fix would touch a denylist path is escalated, never auto-applied.

**Stale `in-progress` recovery:** `in-progress` means "dispatched this iteration" and
normally resolves to `done`/`escalated` in the same iteration. A node still `in-progress`
at the *start* of a later iteration means the prior run was interrupted (crash / timeout /
budget exhaustion) — it is stale. The re-plan step MUST resolve it (reset it to `ready`
or `blocked` per its current `after:` deps, with a note) before it can be selected again;
never dispatch a leftover `in-progress` node as-is (it may be mid-flight or orphaned).

**Deferred nodes (TRACE "defer is prospective memory"):** a `deferred` node is not
dispatchable, but it is not a dead end either. In each re-plan step, check its `missing`
against the new evidence (fresh records, a dependency now `done`, a check that now runs):
if satisfied, reset it to `ready` and cite the evidence that arrived (a record id or check
output) in its notes — no citation, no reset; if not, leave it. A defer whose `missing` is
a human decision (approval, product call) is never reset by the loop: such a node is
`escalated`, and only that human's answer moves it. Each
defer counts as one attempt toward the >3-attempts red flag — a node deferred for the
fourth time becomes `escalated`. A `deferred` dependency keeps its dependents computed
`blocked` (not dropped, not escalated — the dependency is resolvable); if the deferred
node later escalates or drops, the cascade rules below apply.

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
- **Cascading drop / escalation** (a dependency never reaching `done`): since readiness
  requires every `after:` id to be `done`, a node whose dependency becomes `dropped` or
  `escalated` can never become ready and would sit `blocked` forever. The re-plan step
  MUST resolve such a node the same iteration — never leave it silently stuck:
  - dependency **`dropped`** → drop the dependent too (`origin: cascade from <id>`) if now
    obsolete, or re-point its `after:` to a live node;
  - dependency **`escalated`** → do **not** re-wire to un-block it (its prerequisite work
    is unresolved) — set the dependent `escalated` too, with a note.
  - dependency **`deferred`** → leave the dependent computed `blocked` (see *Deferred nodes*).

## Example (illustrative — not a live row)
```
| LP-001 | Fix hydration warning on /        | —      | done      | TR-1a2b3c4d5e6f | —                                   | critic:frontend-arch rec:TR-0f… | verified 2026-… |
| LP-002 | Add E2E for the cleared-name path | LP-001 | ready     |                 |                                     | critic:qa-e2e rec:TR-9c…        |                 |
| LP-003 | Tighten max-length message        | —      | deferred  | TR-77aa01bb02cc | unit test run of greeting.test.ts   | critic:regression rec:TR-41…    | attempt 1       |
| LP-004 | Rework auth token refresh         | —      | escalated | TR-5e5e6f6f7a7a | human approval: denylisted path     | critic:security rec:TR-c3…      | denylist: auth  |
```

## Plan
_No nodes yet. The first L2/L3 loop run bootstraps nodes here from its confirmed
findings during the re-plan step._

| id | description | after | status | record | missing | origin | notes |
|---|---|---|---|---|---|---|---|
