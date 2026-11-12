---
description: Turn a user story, a spec or a goal into proposed loop-plan nodes (scope, check, after, story link, a "done when" clause) and append each one to .claude/memory/loop-plan.md only after the user confirms it. For work meant to run through /loop; never dispatches anything.
argument-hint: [story id (US-NNN), spec path, or goal text]
---

Plan work for the loop: decompose the source below into **proposed** nodes for the plan DAG
in `.claude/memory/loop-plan.md`. This command is for work meant to run through `/loop` —
`/multi-agent-dev` keeps its own step list (`docs/plans/<slug>/steps.md`) and does not use
the loop plan. It writes only the plan table, and only rows the user confirmed.

Source:
$ARGUMENTS

## Procedure
1. Read `.claude/memory/loop-plan.md` (Node schema, Transitions, *Split on failure*, the
   ready rule) and the source: a story file `docs/stories/US-<id>-*.md` (its acceptance
   criteria, numbered AC1…), a spec under `docs/`, or the goal text.
2. Draft the nodes. Each one is a bounded unit a single loop dispatch can finish:
   - `description`: one line ending `— done when: <the observable outcome>`, written from
     the source's acceptance criterion, never from implementer output;
   - shape it the hexagonal way (`CLAUDE.md` *Design principles*): a core change, a port and an
     adapter are separate nodes when each is big enough to need its own check;
   - `scope`: the files it may touch, at most 3 (1 literal file if it is to run at L3) —
     a larger unit is split into several nodes now, not later;
   - `check`: the smallest command that proves it (a unit test file, a named Playwright
     spec); a node with no automated check is not proposed — say so instead;
   - `after`: ids of the drafted nodes it depends on (only real order, never to keep two
     nodes from running together: overlapping scopes are kept apart at dispatch);
   - `origin` `plan:<source> <YYYY-MM-DD>`, plus `story:US-NNN#ACk` when the node delivers
     a story's acceptance criterion k;
   - `status` `ready` with no `after`, else `blocked`; `record` and `missing` empty;
   - `id`: a new id (`pnpm -s trace plan-id "<description>"`), never a reused one.
   Never propose a node that would touch a denylist path (`.claude/loop.md`, *Denylist*):
   name it as work for a human instead.
3. Lint the draft before showing it: write the current plan plus the drafted rows to a
   scratchpad copy and run `pnpm trace plan-lint --pre-dispatch --plan <copy>`. Fix every
   error in the draft (a warning you leave, say why).
4. Show the drafted rows as a table, then confirm them with the user **one node at a
   time** (AskUserQuestion: append / edit / skip). Append a node to the `## Plan` table
   only after the user confirms it; a skipped node is not written anywhere, and a node
   that depends on a skipped one is re-asked with that edge removed or skipped too.
5. Run `pnpm trace plan-lint --pre-dispatch` on the real plan and report: the nodes
   appended (ids), the ones skipped, and the ready ids (`pnpm -s trace plan-ready`).

## Rules
- The human confirmation is this command's review gate: `plan-lint` accepts a `plan:` origin
  as reviewed, so never append an unconfirmed row with that origin.
- This command never sets a node `done`, `deferred` or `escalated`, never writes a TRACE
  record, and never starts `/loop` or a workflow; dispatch stays in `/loop` (step 10).
- For a large decomposition (more than about 8 nodes), offer a `/critic-round` over the
  draft before confirming; it is optional.
- Plans live in the repo (`loop-plan.md`), never only in a scratchpad, so another developer
  sees them after a merge.
