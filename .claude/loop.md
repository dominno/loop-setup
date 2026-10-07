You are running a recurring multi-agent development watchdog loop for this localhost web app.

This loop is **hardened with "loop engineering" operating rules** (trust levels,
budget, denylist, escalation, stop conditions). Before running, fix the loop's
**trust level** and stay within it.

## Trust level (declare it before the first iteration)
- **L1 — Report only.** Triage and report findings; make NO code changes, commits,
  or PRs. The default when the level is unstated.
- **L2 — Assisted.** May apply small, in-scope, low-risk fixes with a verifier
  (post-implementation critic) confirming; never auto-merge.
- **L3 — Unattended.** May act without a human watching; requires every section of
  `.claude/loop-checklist.md` to be satisfied first.

## The plan (`.claude/memory/loop-plan.md`) — the DAG every action traces to
The loop's watchlist is a **durable, mutable plan** of typed work nodes with `after:`
dependency edges, kept in `.claude/memory/loop-plan.md` (schema + ready-node rule are
documented there). Two disciplines follow from it:
- **No action without a node.** Every L2/L3 fix the loop dispatches MUST be a **ready
  node** in the plan (its `args.items` `id` = the node `id`). An action with no backing
  node is not taken — the re-plan step creates the node first. Readiness does **not**
  bypass the denylist or trust level; those gates still apply on top.
- **Re-plan is a first-class step** that runs *before* dispatch (step 9 below), not an
  afterthought — the loop consults the fresh DAG before every action.
The plan is the concrete realization of "the watchlist" referenced throughout this file;
`loop-run-log.md` remains the separate, append-only *history*.

## Records — no durable state change without a TRACE record
Every verdict the loop acts on is a typed, append-only TRACE-lite record
(`.claude/memory/trace/records.jsonl`, policy in `.claude/memory/topics/trace.md`), written
**only** through `pnpm trace write` / `pnpm trace act` (never hand-edited, never by an
implementer diff). Verdicts are typed — `accept`/`qualify` license action, `defer` names
what is `missing`, `revise` carries a `repair`, `reject` is refuted — and a consumer acts
fail-closed: a plan node moves to `done` only with an `accept`/`qualify` record written by
the **loop-iteration verifier for that node** plus a `CLEAR` action on it;
`deferred`/`escalated` moves carry a `HOLD`. How to write and act on records — and what
`defer`/`revise`/`reject` mean for a consumer — is the **consumer protocol** in
`.claude/memory/topics/trace.md`. The store, `loop-plan.md` and `loop-run-log.md` are the
loop's *state*, written by the Lead (never by an implementer diff); they are not its
instructions — the self-modification guard below still applies to everything else.

## Per-iteration process (act as Lead Agent)
1. **Read state first:** open **`.claude/memory/loop-plan.md`** (the current plan/DAG)
   and `.claude/memory/loop-run-log.md` (prior iterations, outcomes, human overrides),
   plus the open TRACE defers (`pnpm -s trace query --latest --status defer`) — the
   loop-resolvable ones (a check to run, a dependency to land) are what this iteration
   should try to supply; defers whose `missing` is a human decision wait for that human,
   and check **remaining budget** against the per-run cap (turns or tokens — see
   *Budget & limits*) before doing anything; stop and escalate if it is already
   exhausted. **If no per-run cap was declared, default to 25 turns and record that you
   used the default** in the run-log entry.
2. **Orient on the plan:** note its current ready nodes (shorthand: `status` not
   done/dropped/escalated/in-progress/deferred AND all `after:` deps `done` — illustrative only;
   always defer to the plan's ready-node rule for the exact formula). Node *selection*
   is deferred to step 10
   (after re-plan) so dispatch always consults the freshest DAG — never act on a raw
   finding here.
3. Check git status and changed files.
4. Start or reuse the dev server.
5. Open the relevant localhost page in Chrome or Playwright MCP.
6. Check browser console errors and failed network requests.
7. Run the critic round as the **critic-panel Workflow**
   (`.claude/workflows/critic-panel.js`, `args.focus` = the current task/flow,
   `args.priorRecords` = `pnpm -s trace query --latest --writer critic-panel --json`,
   `args.treeId` = `pnpm -s trace tree-id`): critics fan out as parallel
   subagents, each finding gets a typed verdict from a separate skeptic, and unchanged
   prior verdicts are reused instead of re-verified. Render the returned `confirmed`
   matrix (with each verdict + qualifier) and list `deferred`/`revised` with their
   `missing`/`repair` (and any `failedReviewers` — an incomplete round). Record the
   round per the consumer protocol (scratchpad file → `pnpm trace write <file>` →
   `pnpm trace act --from <file>`) before using any finding.
8. **Maker/checker:** the pass that verifies a fix must be *separate* from the one
   that made it — the implementer never marks its own work "done".
9. **Re-evaluate & re-plan** (a first-class step, not an afterthought) — run this
   **before** any dispatch so the DAG is fresh when you act. Rewrite
   `.claude/memory/loop-plan.md`: nodes already `done` (record + `CLEAR`) unblock their
   dependents — re-plan never marks a node `done` itself; **add new nodes** for this run's
   confirmed findings (with `after:` deps + `origin` citing the finding's record id) and,
   for a critic finding the round `deferred`, a `deferred` node carrying its `missing`
   (only if the loop can supply it; a human-decision defer or a `revise` becomes an
   `escalated` node with the `missing`/`repair` as the human ask); re-order by priority;
   `drop` obsolete nodes; **re-check every `deferred` node's `missing`** — reset it to
   `ready` only when you can cite the evidence that arrived (a record id or check output,
   in the node's notes); a fourth defer escalates it; never reset an `escalated` node —
   only the human it waits on can; and recompute which nodes are `ready`. New evidence may re-shape the DAG here
   — that is the point. Also **repair broken states** (see the plan's rules): reset any
   stale `in-progress` node left by an interrupted prior run, and **cascade-resolve** any
   node whose `after:` dep became `dropped`/`escalated` (drop, re-point, or escalate it)
   so nothing is left silently `blocked`. Node creation is the *only* loop action exempt
   from "no action without a node"; it is the sanctioned bootstrap, so an
   empty/first-iteration plan is populated here rather than deadlocking. Record the
   re-plan delta in the run-log entry.
10. **Select & act — only within the trust level** (**if no level was explicitly
    declared for this run, treat it as L1 — never infer L2/L3 from context**). Pick the
    highest-priority **ready node(s)** from the just-updated plan:
    - L1: record findings only (no dispatch).
    - L2/L3: set the selected nodes `in-progress` in the plan, then fix them via the
      **loop-iteration Workflow** (`.claude/workflows/loop-iteration.js`, `args.level` =
      the declared level, `args.treeId` = `pnpm -s trace tree-id`, `args.items` = those
      **ready plan nodes**, each `id` = the node `id`, plus `priorRecordId`/`missing` for a
      re-dispatched node; **no action without a node**): an implementer subagent fixes
      each in an isolated worktree and a *separate* verifier reviews the real diff and
      returns a typed verdict (a hard denylist gate also forces escalation — readiness
      does not bypass it). If the workflow returns `error` or `budgetStopped`, no verdict
      exists: reset the nodes to `ready`, write no records, log it, and stop (budget
      exhausted → escalate). Otherwise record its `traceRecords` per the consumer
      protocol — **before** moving any node. Then, per item:
      - **`applied`** (accept/qualify): at **L3 only an `accept` is applied** — a `qualify`
        is HELD for a human. Apply the `diff` patch and re-run the smallest relevant
        check. If it passes, `pnpm trace act <that node's loop-iteration record> loop CLEAR
        --ref <node> --note "<check that passed; qualifier if any>"` and mark the node
        `done` with that `record` (copy a qualifier into the node's notes). If no relevant
        automated check exists, do not CLEAR: `HOLD` and escalate. If the check fails,
        revert the patch, write a `revise` record (`revises` the first, `repair` = what
        failed), `HOLD` it, and leave the node `ready` with the attempt counted.
      - **`deferred`** (defer): `HOLD`, set the node `deferred`, copy the record's
        `missing` into the node (a denylist defer — `missing` = human approval — makes the
        node `escalated` instead).
      - **`rejected`** (reject/revise/denylist): `HOLD`, set the node `escalated`; its
        `missing` = the record's `missing`, else its `repair`, else "a human decision on:
        <the record's reason>" — never empty.
      Never fix nice-to-haves automatically; never start unrelated refactors.
    - **If no node is ready** after re-plan, do not invent work — **self-stop** (per
      *Stop when*).
11. **Append a run entry** to `.claude/memory/loop-run-log.md` (see format below).

## Denylist — never touch autonomously (escalate instead)
(The TRACE record store under `.claude/memory/trace/` is appended only through
`pnpm trace` by the Lead/checker; an implementer diff touching it is a denylist hit like
any other `.claude/` path.)
Auth, payments, secrets/`.env`, infrastructure/deploy, CI workflow config, and
database migrations. Also: do not push, deploy, delete data, modify secrets, or
auto-merge without an explicit allowlist — and never commit or push unless the user
explicitly allowed it for this loop (CLAUDE.md: commit/push only when asked). **And the
agent's own configuration and
prompt surface — `.claude/` (commands, workflows, `loop.md`, `loop-checklist.md`,
the memory wiki's topic pages) and `CLAUDE.md`, plus the TRACE gate code in
`scripts/trace/`: a loop never self-modifies its own instructions or gates
autonomously, even at L3 — propose and escalate instead** (this is enforced
deterministically by the `loop-iteration.js` denylist regex; the sanctioned path to
change the prompt surface is the manual, confirmation-gated `/improve-skills`). The
loop's state files (`loop-plan.md`, `loop-run-log.md`, the record store via `pnpm
trace`) are the exception: the Lead writes them as part of every iteration.

## Escalate to a human (pause and ask) when
- A fix would touch a denylist path.
- An item hits the **max attempts** (see red flags) without progress.
- The right fix is ambiguous or architecturally significant (use AskUserQuestion).
- The budget is exhausted.
Notify only when action is needed — do not ping on a no-op run.

## Red-flag stop conditions (halt and escalate)
- The same issue/PR has **>3 fix attempts** without forward progress.
- The verifier is the same pass/session as the implementer.
- There is no run-log/state (memory loss between runs).
- You'd notify on every run regardless of findings.
- A plan node is about to become `done` without an `accept`/`qualify` record and a
  `CLEAR` action, or a node is `deferred`/`escalated` with no `missing` (an unresolvable
  hold is a silent dead end).
- Auto-merge is enabled without a path allowlist.

## Budget & limits
- Declare a **per-run cap** with the trust level — a turn budget (e.g. 25 turns) or
  a token ceiling — and record remaining budget in every run-log entry; stop and
  escalate when reached.
- Max iterations per item per run: small (e.g. 3). Max auto-PRs per day: small.
- A loop with an empty watchlist **MUST** self-stop, not spin.

## Stop when
- No blockers remain, browser verification passes, relevant tests pass, and the
  current task has clear evidence of completion — or a stop condition above fires.
- Or every remaining claim has a terminal TRACE outcome (paper §5.4): **(1)** accepted/
  qualified and acted on, **(2)** rejected, **(3)** deferred with a named `missing` the loop
  cannot supply this run — report those `missing` lists as the human ask, or **(4)
  diminishing returns** — this iteration changed nothing that matters (no node changed
  status and no verdict changed versus the previous iteration — new records that merely
  repeat old verdicts do not count): stop and report rather than spin.

## Run-log entry (append to `.claude/memory/loop-run-log.md`)
```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- node: <plan-item id acted on, or "none — report-only / no ready node">
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- re-plan: <nodes added / marked done / deferred→ready / dropped, or "none">
- records: <record ids written + actions (CLEAR/HOLD/REUSE), or "none">
- budget: <used>/<cap> (turns or tokens)
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Each loop report must include: current task, trust level, localhost status, critic
matrix (with typed verdicts), fixes applied, TRACE records written (+ open defers and
their `missing`), browser evidence, test evidence, escalations, and remaining risks.
