# Planning guide: how work is planned, tracked and dispatched

This guide is for the people running this setup. The rules themselves live in
[`.claude/memory/loop-plan.md`](../.claude/memory/loop-plan.md) (node schema, transitions,
split rule) and [`.claude/loop.md`](../.claude/loop.md) (steps 9 and 10). This page explains how
to use them.

![Planning and task status in the loop: plan the work with /plan-nodes, the node row, the status lifecycle with split on failure and the attempt budget, and safe dispatch with plan-lint --pre-dispatch, plan-ready --batch, the two-developer rules and the commands](infographic-5-planning.png)

(Source: [`infographic-5-planning.svg`](infographic-5-planning.svg).)

## 1. Which planning surface to use

| You want to… | Use | Where the plan lives |
|---|---|---|
| Have `/loop` do the work, unattended or assisted | `/plan-nodes <story id \| spec path \| goal>` | `.claude/memory/loop-plan.md` |
| Build it yourself, now, with critics | `/multi-agent-dev <task>` | `docs/plans/<slug>/steps.md` |
| Get a `/goal` prompt for a big outcome | `/write-goal <outcome>` | It also prints blocked `human:goal` rows, which you paste into the plan |

All three keep the plan in the repo, never only in a scratchpad, so a teammate sees it after a
merge. `/plan-nodes` proposes every node and appends it only after you confirm it. Neither
`/multi-agent-dev` nor `/write-goal` runs `/plan-nodes` for you; they only offer it.

## 2. Anatomy of a plan node

One node is one row of the table under `## Plan`:

```
| id | description | after | status | record | missing | origin | notes | scope | check |
| LP-a3f9c2 | Empty name crashes — done when: '' shows the error | — | ready | | | plan:docs/stories/US-001 2026-11-06 story:US-001#AC2 | | src/lib/greeting.ts | pnpm vitest run src/lib/greeting.test.ts |
```

- **`id`**: get a fresh one with `pnpm trace plan-id "<description>"`. It returns `LP-<6 hex>`,
  so two people never pick the same id. Old `LP-NNN` ids stay valid.
- **`description`**: one line ending in `— done when: <an observable outcome>`.
- **`scope`**: the files the node may touch. At most 3 at L2, and exactly 1 literal file at L3.
- **`check`**: the smallest command that proves the node is done. A ready node with no check is
  never dispatched.
- **`origin`**: where the node came from. It is one of: a critic record (`rec:TR-…`),
  `plan:<source> <date>` (from `/plan-nodes`), `human`/`human:goal <date>`, or
  `cascade from`/`split from <id>`. Add `story:US-NNN#ACk` to link the node to acceptance
  criterion k of a story.
- **`record` / `missing`**: the loop fills these from TRACE verdicts. Never edit them by hand to
  move a status.
- A table with the old 8-column header (no `scope`/`check`) still parses.

**Priority is computed.** The order is: blocker findings first, then important ones, then
everything else (human nodes included). Within one tier, table order decides, so you reorder a
tier by moving rows.

## 3. The status lifecycle

- **`blocked` → `ready`**: when every `after:` dependency is `done`. This is computed, never set
  by hand.
- **`ready` → `in-progress`**: when the loop dispatches the node. Its notes get a claim,
  `claim:<owner>@<run-id>` (from `pnpm trace claim-token`).
- **`in-progress` → `done`**: only with the node's own verifier `accept`/`qualify` and a `CLEAR`.
- **`in-progress` → `deferred`**: on a `defer`. The loop can resolve it: the node goes back to
  `ready` once a newer record supplies what is missing.
- **`in-progress` → `escalated`**: on a reject, a revise, a denylist hit or a human decision.
  Only you move it back, with a release:
  `pnpm trace act <record> human HOLD --ref <node> --note "release: <decision>"`.
- **The attempt budget is 3.** Every defer and every revise counts. A node with a 4th attempt
  becomes `escalated`.
- **Split on failure.** A node that failed as one unit gets split, not retried:
  - the parent becomes `dropped` with the note `split into LP-a, LP-b`;
  - it has 2–4 children, each with origin `split from <parent> rec:<record>`;
  - the parent's dependents move to all the children;
  - splits go at most 2 levels deep, and the children inherit the parent's attempts plus one;
  - at L2 you confirm the split through `/plan-nodes`; at L3 the node is escalated instead.
- **`done` never moves back.** New work on the same thing is a new node with a new id.

The full table of allowed transitions is in `loop-plan.md`, *Transitions*.

## 4. Commands

| Command | What it tells you |
|---|---|
| `pnpm trace plan-lint` | Whether the plan is consistent with its rules and with the record store |
| `pnpm trace plan-lint --pre-dispatch` | The dispatch-time gates. Errors: `[check]`, `[oversize]`, `[origin]`, a stale `in-progress`. Warnings: `[scope]`, `[done-when]`. Use `--max-scope 1` at L3 |
| `pnpm trace plan-ready [--max N \| --batch N] [--json]` | The ready ids in priority order. `--batch N` keeps only nodes whose scopes don't overlap |
| `pnpm trace plan-items <ids…>` | The work items for loop-iteration. The item shape is unchanged |
| `pnpm trace plan-id "<description>"` | A fresh, collision-free node id |
| `pnpm trace claim-token` | The claim the loop writes when it dispatches a node |
| `pnpm trace status` | A read-only rollup: nodes per status and per story, claims and their age, oversize nodes, attempts |
| `pnpm trace plan-drift` | What changed since the last run, and diff paths that fell outside a node's scope (advisory only) |
| `pnpm trace story-lint` | The story map, plus each story's open plan nodes |
| `pnpm trace reaudit --claim-prefix story:` | Story statuses whose evidence changed since they were recorded |

`status`, `plan-drift` and `plan-lint` report consistency, not truth. Never cite their output as
evidence for a record.

## 5. A typical session

1. `/plan-nodes US-002`. Review each proposed node (scope, check, `done when:`) and confirm it,
   edit it, or skip it.
2. `pnpm trace plan-lint --pre-dispatch` must pass, and `pnpm trace plan-ready --batch 5` shows
   what runs next.
3. `/loop` at L1 first. The checklist requires one logged L1 iteration before L2. Then go to L2.
   At L3, `/bench-checkers` must have been re-run first.
4. Watch progress with `pnpm trace status`. When a node escalates, read its `missing`; that is
   what the loop is asking you for.

## 6. Working as a team

See [`adoption-guide.md` → *Working as a team*](adoption-guide.md#working-as-a-team).

In short:
- node ids never collide;
- claims have owners, and nobody resets another person's claimed node;
- on a shared branch, commit and push a claim before dispatching; if the push is rejected,
  re-plan;
- the logs merge as a union;
- merge PRs with a merge commit, never a squash.
