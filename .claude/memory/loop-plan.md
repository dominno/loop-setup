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
One row per node in the table below. The header is
`| id | description | after | status | record | missing | origin | notes | scope | check |`;
a table with the legacy 8-column header (no `scope`/`check`) still parses, its nodes reading as
an empty scope and check.

| Field | Meaning |
|---|---|
| `id` | Stable node id, `LP-NNN` (never reused after `done`/`dropped`). |
| `description` | One line — the bounded unit of work, ending `— done when: <observable outcome>` (from the origin finding's evidence or fix; `[done-when]` warns under `--pre-dispatch` without it). |
| `after` | Comma-separated `id`s this node depends on; empty = no deps. |
| `status` | `ready` · `blocked` · `in-progress` · `deferred` · `done` · `escalated` · `dropped`. |
| `record` | The TRACE-lite `record_id` behind the node's latest status change (`pnpm trace show <id>`): the node's own `loop:<id>` record; for a node created `deferred`/`escalated` from a critic finding, that critic record, HOLDed for the node (`pnpm trace act <record> loop HOLD --ref <id>`); for a cascade-escalated node, its escalated ancestor's HOLDed record. Empty only while `ready`/`blocked` with no verdict yet. |
| `missing` | For `deferred`/`escalated`: the evidence or decision that would unblock it — the record's `missing`, else its `repair`, else "a human decision on: <its reason>". Never empty. |
| `origin` | Where it came from: a confirmed critic finding (cite its record id), a re-plan, or a human. |
| `notes` | Evidence / decision trail (attempt count, escalation reason). |
| `scope` | Comma-separated repo-relative files (or globs) the node may touch, taken from its origin finding's `file:line` at creation. Lead-side only: it drives dispatch-time exclusion and the dirty-file skip (loop.md step 10), never the verifier's item. Empty (`—`) warns under `--pre-dispatch` and dispatches alone. |
| `check` | The smallest command that proves the node (e.g. `pnpm vitest run src/x.test.ts`, a named Playwright spec): the post-apply check the Lead runs before any `CLEAR`. A `ready` node with an empty `check` fails `plan-lint --pre-dispatch` — escalate a node that has no automated check before it is dispatched, not after. |

Not adopted for this plan, deliberately (a JSON plan, epic/parent containers, a complexity
score, a new node status, bd-style commands): see `.claude/memory/topics/workflow.md`,
*Not adopted (plan)*, which also says what evidence would reopen each.

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

**Pruning:** a `done` or `dropped` row may later be pruned from the table (its trail stays in
`loop-run-log.md` and the record store). Pruning it also deletes its id from every remaining
`after:` — a dangling id fails `plan-lint`, because its dependent could never become ready.
Deleting a `done` id changes no readiness, but deleting a `dropped` one would make its live
dependents ready with no cascade decision: prune a `dropped` row only once no live node lists
it in `after:`, so cascade-resolve those nodes first (`plan-lint`'s `[stranded]` rule names them).
A pruned id is never reused: number a new node above the highest `LP` id ever used, in the
table and in the store's `loop:<id>` claims (`pnpm trace query --writer loop` lists them),
because `plan-lint` ties records to the id — a reused id inherits the old node's defers and its
CLEARed verdict (`plan-lint` warns `[reused-id]` while such a node is not `done`).

## Transitions
Which status changes are sanctioned, and what each needs (`plan-lint` checks the state each
leaves; it never diffs against the previous plan). Anything not listed is not a transition.

| From | To | Needs |
|---|---|---|
| (new) | `ready` / `blocked` | a node-creation origin (loop.md step 9); `blocked` while an `after:` dep is open |
| `blocked` | `ready` | every `after:` dep `done` (computed) |
| `ready` | `in-progress` | step 10 dispatch, only after `plan-items` built the item |
| `in-progress` | `done` | the node's own verifier accept/qualify + `CLEAR --ref <node>` |
| `in-progress` | `deferred` / `escalated` | a HOLDed record (step 10 branches) |
| `in-progress` | `ready` | a failed post-apply check (`revise`, writer `loop/post-apply:<node>`, HOLDed), a workflow `error`/`budgetStopped`, or stale recovery |
| `deferred` | `ready` / `blocked` | a record written after the defer, cited in notes, or an infra-path reset (agent-failed, base-mismatch, `loop/apply-check`, a `run-log [YYYY-MM-DD HH:MM]` infra entry) |
| `escalated` | `ready` / `blocked` | a human release on its record: `HOLD`, consumer `human`, `--ref <node>`, note `release: …` |
| any live | `dropped` | re-plan obsoletes it, cascades from a dropped dep, or splits it (*Split on failure*) |
| `done` | anything | never — new work is a new node (`[reused-id]` is an error when a non-done node cites its own CLEARed record) |

`[unsupported-reset]` fails a `ready`/`blocked` node that cites a HOLDed escalation-grade
record (a `revise`, a `reject`, a human-decision or denylist `defer`) with no human release,
and a `ready` node on its own HOLDed defer whose notes cite no newer record (the infra-path
resets above excepted).

## Ready-node rule (what the loop dispatches next)
A node is **ready** iff `status ∉ {done, dropped, escalated, in-progress, deferred}` **and**
every `id` in its `after:` is `done`. The loop picks the highest-priority ready node.
**Priority** is computed from the node's origin record's `severity` (the first record its
`origin` cites): `blocker`, then `important`, then everything else (a human origin included);
table order breaks ties, so a human reorders by moving rows within one tier. Severity comes
from same-model critics: it is triage, not ground truth. Denylist and trust-level gates still apply **on top** of readiness — a ready node
whose fix would touch a denylist path is escalated, never auto-applied.

**Computed, not hand-derived:** `pnpm trace plan-ready` prints the ready ids in priority order
(`--max N` keeps the first N; a store that does not replay exits 2), and `pnpm trace plan-lint` checks the rest of this contract
against the record store: statuses, `after:` edges, cycles, stranded nodes, and each node's
record and consumer actions. It checks consistency, not truth: it shows that the table and
the records agree, not that a fix is right or that a `missing` was really supplied. A table
that does not parse fails closed (exit 1, no ids).

**Stale `in-progress` recovery:** `in-progress` means "dispatched this iteration" and
normally resolves to `done`/`escalated` in the same iteration. A node still `in-progress`
at the *start* of a later iteration means the prior run was interrupted (crash / timeout /
budget exhaustion) — it is stale. The re-plan step MUST resolve it (reset it to `ready`
or `blocked` per its current `after:` deps, with a note) before it can be selected again;
never dispatch a leftover `in-progress` node as-is (it may be mid-flight or orphaned).

**Deferred nodes (TRACE "defer is prospective memory"):** a `deferred` node is not
dispatchable, but it is not a dead end either. In each re-plan step, check its `missing`
against the new evidence (fresh records, a dependency now `done`, a check that now runs):
if satisfied, reset it to `ready` and cite the evidence that arrived (a record written after
the defer, by id) in its notes — no citation, no reset (`plan-lint` `[unsupported-reset]`); if not, leave it. One reset needs no new
evidence: a node deferred by a record whose `failed_gates` include `agent-failed` (an infra
failure: the agent died, so nothing was weighed) may be reset citing that defer record's own
id (`loop.md` step 9 lists the other record-cited resets). A reset keeps the node's `record`
and `missing` columns. `pnpm trace plan-items` passes `missing` on as the item's `missing`,
and the `record` as its `priorRecordId` only when it is the node's own `loop:<id>` record (the
new verdict revises it, so the claim keeps one chain). A critic record is never passed on:
revising it across claims would supersede a finding that is still open and drop it from the
next critic round's priors, so it stays HOLDed for the node until a critic round re-reviews
it. A defer whose `missing` is
a human decision (approval, product call) is never reset by the loop: such a node is
`escalated`, and only that human's answer moves it. Each
attempt counts toward the >3-attempts red flag — every defer (an agent-failed one included)
and every revise (a verifier's, or the Lead's failed post-apply check) on the node's
`loop:<id>` claim — so a node with a fourth attempt becomes `escalated` (`plan-lint`'s
`[attempts]` counts those records and fails on any live node past the budget). A `deferred` dependency keeps its
dependents computed `blocked` (not dropped, not escalated — the dependency is resolvable);
if the deferred node later escalates or drops, the cascade rules below apply.

## No action without a node
Every L2/L3 dispatch (`loop-iteration.js` `args.items`) MUST be ready nodes from this
table — each item's `id` is its node `id` (`pnpm trace plan-items <ids>` builds the items and
refuses an id that is not ready). An action with no backing node is **not
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
    is unresolved) — set the dependent `escalated` too, with a note. It cites the escalated
    ancestor's HOLDed record in `record`, with `origin: cascade from <id>`.
  - dependency **`deferred`** → leave the dependent computed `blocked` (see *Deferred nodes*).

## Split on failure (as-needed decomposition, ADaPT)
A node is split only after it failed as one unit, never up front, and only from a recorded
verdict: its own `loop:<id>` **revise with a non-empty `repair`** (a verifier's, or the Lead's
failed post-apply check), or its own **defer whose `missing`/`reason` names the scope** (too
large, split it). Only a `deferred` node, or a `ready` one carrying such a record, is split.
Never split a `reject`, a denylist hit, a human-decision defer, an `escalated` node, or a node
whose origin record is in the latest round's `completion.notRechecked`.
- **Parent:** set `dropped`, notes `split into LP-a, LP-b`; HOLD the triggering record for it
  (`pnpm trace act <record> loop HOLD --ref <parent>`).
- **Children (2–4):** each a new node with `origin: split from <parent> rec:<triggering record>`
  (plus the parent's critic record, if it had one: a child that cites it in `record` HOLDs it
  `--ref <child>`), its own `scope`, `check` and `done when:` clause, and `after:` edges between
  children where order matters.
- **Dependents:** re-point every node that listed the parent in `after:` to **all** the
  children, or — when the children are chained by `after:` — to the last one; never to the
  last child of an unchained set.
- **Attempts:** a child inherits its parent's attempts, plus one for the split; the budget
  (`MAX_ATTEMPTS`) applies to that sum, so a split never resets the count.
- **Depth:** at most 2 levels (a split of a split); deeper, escalate.
- **Trust level:** at L2 the split rows are proposed through the `/plan-nodes` confirmation
  path (a human confirms them); at L3 the node is escalated instead of split until
  `/bench-checkers` has measured split nodes. Each split is logged in the run-log re-plan delta.

`plan-lint` checks the state: `[split]` (the parent is dropped and lists 2–4 children that
exist and name it; no dependent points at only part of an unchained set), `[split-origin]`
(a child's origin cites the parent's own triggering revise/defer), `[split-depth]`, and
`[split-of]` (a live node that re-creates a dropped, attempted node's finding must declare
`split from`, or drop-and-recreate would reset the attempt count). This is how the plan covers
hierarchy: no parent/epic container, just dropped parents with their `split into` trail.

## Example (illustrative — not a live row)
```
| LP-001 | Fix hydration warning on /        | —      | done      | TR-1a2b3c4d5e6f | —                                   | critic:frontend-arch rec:TR-0f… | verified 2026-… | src/app/page.tsx         | pnpm test:e2e e2e/home.spec.ts            |
| LP-002 | Add E2E for the cleared-name path | LP-001 | ready     |                 |                                     | critic:qa-e2e rec:TR-9c…        |                 | e2e/remember-me.spec.ts  | pnpm test:e2e e2e/remember-me.spec.ts     |
| LP-003 | Tighten max-length message        | —      | deferred  | TR-77aa01bb02cc | unit test run of greeting.test.ts   | critic:regression rec:TR-41…    | attempt 1       | src/lib/greeting.ts      | pnpm vitest run src/lib/greeting.test.ts  |
| LP-004 | Rework auth token refresh         | —      | escalated | TR-5e5e6f6f7a7a | human approval: denylisted path     | critic:security rec:TR-c3…      | denylist: auth  | src/lib/auth.ts          | —                                         |
```

## Plan
_No nodes yet. The first L2/L3 loop run bootstraps nodes here from its confirmed
findings during the re-plan step._

| id | description | after | status | record | missing | origin | notes | scope | check |
|---|---|---|---|---|---|---|---|---|---|
