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

## Per-iteration process (act as Lead Agent)
1. **Read state first:** open **`.claude/memory/loop-plan.md`** (the current plan/DAG)
   and `.claude/memory/loop-run-log.md` (prior iterations, outcomes, human overrides),
   and check **remaining budget** against the per-run cap (turns or tokens — see
   *Budget & limits*) before doing anything; stop and escalate if it is already
   exhausted. **If no per-run cap was declared, default to 25 turns and record that you
   used the default** in the run-log entry.
2. **Orient on the plan:** note its current ready nodes (shorthand: `status` not
   done/dropped/escalated/in-progress AND all `after:` deps `done` — illustrative only;
   always defer to the plan's ready-node rule for the exact formula). Node *selection*
   is deferred to step 10
   (after re-plan) so dispatch always consults the freshest DAG — never act on a raw
   finding here.
3. Check git status and changed files.
4. Start or reuse the dev server.
5. Open the relevant localhost page in Chrome or Playwright MCP.
6. Check browser console errors and failed network requests.
7. Run the critic round as the **critic-panel Workflow**
   (`.claude/workflows/critic-panel.js`, `args.focus` = the current task/flow):
   critics fan out as parallel subagents and findings are adversarially verified.
   Render the returned `confirmed` matrix.
8. **Maker/checker:** the pass that verifies a fix must be *separate* from the one
   that made it — the implementer never marks its own work "done".
9. **Re-evaluate & re-plan** (a first-class step, not an afterthought) — run this
   **before** any dispatch so the DAG is fresh when you act. Rewrite
   `.claude/memory/loop-plan.md`: mark nodes verified done in a prior iteration as
   `done` (unblocking their dependents), **add new nodes** for this run's confirmed
   findings (with `after:` deps + `origin`), re-order by priority, `drop` obsolete
   nodes, and recompute which nodes are `ready`. New evidence may re-shape the DAG here
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
    - L2/L3: fix the selected nodes via the **loop-iteration Workflow**
      (`.claude/workflows/loop-iteration.js`, `args.items` = those **ready plan nodes**,
      each `id` = the node `id`; **no action without a node**): an implementer subagent
      fixes each in an isolated worktree and a *separate* verifier reviews the real diff
      and approves/rejects (a hard denylist gate also forces escalation — readiness does
      not bypass it). For each **approved** item, apply its returned `diff` patch, re-run
      the smallest relevant check, then mark that node `done` in the plan; escalate
      `rejected`/`escalate` items (set the node `escalated`). Never fix nice-to-haves
      automatically; never start unrelated refactors.
    - **If no node is ready** after re-plan, do not invent work — **self-stop** (per
      *Stop when*).
11. **Append a run entry** to `.claude/memory/loop-run-log.md` (see format below).

## Denylist — never touch autonomously (escalate instead)
Auth, payments, secrets/`.env`, infrastructure/deploy, CI workflow config, and
database migrations. Also: do not push, deploy, delete data, modify secrets, or
auto-merge without an explicit allowlist. **And the agent's own configuration and
prompt surface — `.claude/` (commands, workflows, `loop.md`, `loop-checklist.md`,
the memory wiki) and `CLAUDE.md`: a loop never self-modifies its own instructions
autonomously, even at L3 — propose and escalate instead** (this is enforced
deterministically by the `loop-iteration.js` denylist regex; the sanctioned path to
change the prompt surface is the manual, confirmation-gated `/improve-skills`).

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

## Run-log entry (append to `.claude/memory/loop-run-log.md`)
```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- node: <plan-item id acted on, or "none — report-only / no ready node">
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- re-plan: <nodes added / marked done / dropped, or "none">
- budget: <used>/<cap> (turns or tokens)
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Each loop report must include: current task, trust level, localhost status, critic
matrix, fixes applied, browser evidence, test evidence, escalations, and remaining risks.
