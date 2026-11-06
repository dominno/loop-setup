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
2. **Orient on the plan:** run `pnpm -s trace plan-ready` for its current ready nodes
   (the plan's ready-node rule, computed — never derived by hand; exit 1 means the plan
   table does not parse: repair it in step 9 before any dispatch). Node *selection*
   is deferred to step 10
   (after re-plan) so dispatch always consults the freshest DAG — never act on a raw
   finding here.
3. Check git status and changed files.
4. Start or reuse the dev server.
5. Open the relevant localhost page in Chrome or Playwright MCP.
6. Check browser console errors and failed network requests.
7. Run the critic round as the **critic-panel Workflow**
   (`.claude/workflows/critic-panel.js`, `args.focus` = the current task/flow,
   `args.priorRecords` = `pnpm -s trace query --latest --writer critic-panel --brief`,
   `args.treeId` = `pnpm -s trace tree-id`): critics fan out as parallel
   subagents; every blocker, and each important finding up to the verifier cap, gets a
   typed verdict from a separate skeptic; the rest are recorded as defers. Unchanged
   prior verdicts are reused instead of re-verified. When UI or perf lenses are in scope
   (a UI flow, or a change that can move the client bundle), first run `pnpm test:e2e`
   (including `e2e/a11y.spec.ts`) and `pnpm build && pnpm check:bundle` yourself and pass
   their output as `args.priorEvidence`: the critics and skeptics never run E2E, and never
   build or test in the shared checkout (their SAFETY rules), so a result you did not
   supply is reported as missing evidence. Print `error` first if present
   (every lens failed: no review happened), then `completion` (the claim next to
   `completion.verdict`, and its `missing`; `notRechecked` lists the prior records of
   lenses this round did not review, which its evidence can never clear, drop or
   resolve). Render the returned `confirmed` matrix (with each verdict + qualifier) and
   list `deferred`/`revised` with their `missing`/`repair` (and any `failedReviewers` —
   an incomplete round). Record the round per the consumer protocol (scratchpad file →
   `pnpm trace write <file>` → `pnpm trace act --from <file>`) before using any finding.
8. **Maker/checker:** the pass that verifies a fix must be *separate* from the one
   that made it — the implementer never marks its own work "done".
9. **Re-evaluate & re-plan** (a first-class step, not an afterthought) — run this
   **before** any dispatch so the DAG is fresh when you act. Rewrite
   `.claude/memory/loop-plan.md`: nodes already `done` (record + `CLEAR`) unblock their
   dependents — re-plan never marks a node `done` itself; **add new nodes** for this run's confirmed findings (each with a fresh id from
   `pnpm -s trace plan-id "<description>"`, `after:` deps + `origin` citing the finding's record id, a
   `scope` from the finding's `file:line`, a `check` that proves the fix, and a description
   ending `— done when: <the observable outcome>`, written from the origin finding's evidence
   or recommended fix, never from implementer output; `plan-lint --pre-dispatch` warns
   `[done-when]` without one, but a weak clause still passes, and the clause changes the
   verifier's behaviour only if the `<loop-verifier>` prompt changes — a bench-gated decision) and,
   for a critic finding the round `deferred`, a `deferred` node carrying its `missing`
   (only if the loop can supply it; a human-decision defer or a `revise` becomes an
   `escalated` node with the `missing`/`repair` as the human ask) — a node created
   `deferred` or `escalated` from a critic finding cites that critic record in its `record`,
   and you HOLD it for the node: `pnpm trace act <critic record> loop HOLD --ref <node id>`;
   re-order by priority;
   `drop` obsolete nodes — never one whose `origin` record is in the latest round's
   `completion.notRechecked` (its lens was not reviewed, so nothing shows it obsolete);
   **re-check every `deferred` node's `missing`** — reset it to
   `ready` only when you can cite the evidence that arrived (a record written after the defer,
   by id in the node's notes — `plan-lint` `[unsupported-reset]` checks it); a node deferred by a record whose `failed_gates` include
   `agent-failed` (an infra failure, not a verdict) may be reset citing that record's id,
   and so may one deferred by your own `git apply --check` record (writer_id
   `loop/apply-check:<node>`, step 10; never by another defer whose `missing` reads the
   same), or by a record whose `failed_gates` include `base-mismatch` (set only by the
   workflow's base check) once the worktree base can match HEAD (the user has set
   `worktree.baseRef`, step 10; until then a re-dispatch defers again, so report it as
   the human ask instead); each such reset counts as an attempt like any
   defer, and so does a node that step 10 reset to `ready` because loop-iteration
   returned its whole-phase infra `error` (every implementer failed, so no record exists:
   cite the run-log entry that noted the error); a fourth attempt of any kind escalates it (`plan-lint` `[attempts]` counts the node's
   `loop:<id>` defers and revises, and fails on a live node past the budget);
   never reset an `escalated` node — only the human it waits on can (a human release:
   `pnpm trace act <record> human HOLD --ref <node> --note "release: <decision>"`); and recompute
   which nodes are `ready`. New evidence may re-shape the DAG here — that is the point.
   **Split instead of retry** when a node's own `loop:<id>` revise carries a `repair`, its
   post-apply check failed, or its defer names the scope (too large): drop it with notes
   `split into …`, create 2–4 children `origin: split from <parent> rec:<that record>` and
   re-point its dependents to all of them (or the last of a chained set) — the full rule is
   `loop-plan.md`, *Split on failure*. At L2 propose the children through the `/plan-nodes`
   confirmation path; at L3 escalate the node instead of splitting it. Log the split in the
   run-log re-plan delta.
   Also **repair broken states** (see the plan's rules): reset any
   stale `in-progress` node left by an interrupted prior run; for a node `plan-lint` warns
   `[verified-unlanded]` (its verifier accept was never applied), resume from the accept only
   when the run-log entry names the saved diff, that file still exists and HEAD equals the
   record's provenance commit — and still run denylist-check, `git apply --check` and the
   post-apply check — otherwise HOLD the orphaned accept (`--note "orphaned accept"`) and
   re-dispatch the node; and **cascade-resolve** any
   node whose `after:` dep became `dropped`/`escalated` (drop, re-point, or escalate it —
   an escalated one cites the ancestor's HOLDed record, `origin: cascade from <id>`)
   so nothing is left silently `blocked`. Node creation is the *only* loop action exempt
   from "no action without a node"; it is the sanctioned bootstrap, so an
   empty/first-iteration plan is populated here rather than deadlocking. Record the
   re-plan delta in the run-log entry. Finish with `pnpm -s trace plan-lint --pre-dispatch` (at L3 add `--max-scope 1`, the
   L3 size ceiling; an `[oversize]` node is split or escalated, never dispatched):
   it checks the rewritten plan against its contract and the record store (consistency,
   not truth — exit 1 names each broken rule, exit 2 means the store does not replay).
   **Never dispatch from a plan that fails it:** repair the plan and re-run it, or stop
   and report the rule that needs a human.
10. **Select & act — only within the trust level** (**if no level was explicitly
    declared for this run, treat it as L1 — never infer L2/L3 from context**). Pick the
    highest-priority **ready node(s)** from the just-updated plan:
    - L1: record findings only (no dispatch).
    - L2/L3: list the candidates with `pnpm -s trace plan-ready --batch <maxItems>`
      (`<maxItems>` = the `args.maxItems` you pass loop-iteration, default 5, its own
      default): at most that many ready nodes, highest priority first, whose `scope`
      columns do not overlap (an empty scope overlaps everything, so that node goes alone;
      each skipped id is named on stderr with the node it conflicts with, and waits for a
      later call) — never pick ready nodes by hand. This is a dispatch-time exclusion, never an `after:`
      edge — an artificial edge would cascade-escalate an unrelated node (`loop-plan.md`,
      *Cascading drop / escalation*). Skip, and note, a node whose `scope` files have
      uncommitted changes in the main checkout (`git status --porcelain -- <scope paths>`): its
      worktree branches from HEAD, which lacks them. If that leaves no node to dispatch,
      stop and report "needs a commit of <files>". Then, in this order: write the items
      with `pnpm -s trace plan-items <selected ids> > <scratchpad>/loop-items.json` (exit 1
      = an id is not ready: dispatch nothing and re-plan; exit 2 = the store does not
      replay: dispatch nothing and stop, as for plan-lint); set the selected nodes
      `in-progress` in the plan (only now: an `in-progress` node is never ready, so
      plan-items would refuse it); then fix them via the **loop-iteration Workflow**
      (`.claude/workflows/loop-iteration.js`, `args.level` = the declared level,
      `args.treeId` = `pnpm -s trace tree-id`, `args.headSha` = `git rev-parse HEAD`,
      `args.items` = the array in that file, unedited — each `id` is the node `id`, and a
      re-dispatched node carries `missing` from its `missing` column and, only when its
      `record` is its own `loop:<id>` record, `priorRecordId` (the new verdict revises it;
      a critic record is never passed on, so the still-open finding stays visible to the
      next critic round): the item shape the bench measured; **no action without a node**):
      an implementer subagent fixes each in a fresh isolated worktree (it installs the
      dependencies and reports the commit it started from) and a *separate* verifier
      reviews the real diff and returns a typed verdict (a hard denylist gate also forces
      escalation — readiness does not bypass it — and a diff based on another commit than
      `headSha` is deferred `base-mismatch`, unverified). Loop worktrees branch from local
      HEAD only when the user has set `worktree.baseRef` to `"head"` in their Claude Code
      settings. That is a human change: the loop never edits its own settings. Until it is
      set, the base check defers every item whose worktree base differs; report that as
      the human ask instead of re-dispatching. If the
      workflow returns `error` or `budgetStopped`, no verdict exists: reset the nodes to
      `ready`, write no records, log it, and stop (budget exhausted → escalate). An infra
      `error` (`failed (infra)`: every implementer failed) also counts one attempt per
      dispatched node (step 9): note the error in the run-log entry. An `argument error`
      (no valid `headSha`, more than `maxItems` items) started no agent and counts no
      attempt: correct the call. Otherwise record its `traceRecords` per the consumer
      protocol — **before** moving any node. Then, per item:
      - **`applied`** (accept, or qualify at L2): save the `diff` to a scratch file (name its path in the run-log entry) and,
        **before applying it**, run `pnpm trace denylist-check --patch <file>` (the
        production denylist, read from HEAD, over every path git's own parser finds in the
        patch — catches anything the patch-text parser missed); exit 1 (a hit) or 2 (could
        not verify) → do not apply, `HOLD`, escalate. Exit 0 → `git apply --check <file>`;
        if it fails (the patch does not apply to the current tree), do not apply: `HOLD`
        the record, write your own `defer` record that `revises` it (same `claim_id`, writer_id
        `loop/apply-check:<node>`, `missing` = "a diff based on the current tree",
        `reason` = the check's error), `HOLD` that one too, and set the node `deferred`
        with it — it is re-dispatchable (step 9). If it passes → `git apply <file>`, then run the node's `check` (its smallest relevant
        check), and log in the run-log entry the diff paths that fall outside its `scope` (a
        drift signal, never a gate). If it passes, `pnpm trace act <that node's loop-iteration record> loop CLEAR
        --ref <node> --note "base <baseSha>; patch <hash>; <check that passed>; <qualifier if any>"`
        (`<baseSha>` = the item's reported `baseSha`; `<hash>` = the first 12 hex of
        `git hash-object <patch file>`, so a later commit can be tied back to this apply) and mark the node
        `done` with that `record` (copy a qualifier into the node's notes). If no relevant
        automated check exists, do not CLEAR: `HOLD` and escalate. If the check fails,
        revert the patch, write a `revise` record (same `claim_id`, `revises` the first, writer_id
        `loop/post-apply:<node>`, `repair` = what failed), `HOLD` it, and leave the node `ready` with that record and
        the attempt counted.
        After the CLEAR, remove the item's worktree (its root is in the item's `notes`,
        self-reported) only if it appears in `git worktree list --porcelain`, lies under
        `<repo>/.claude/worktrees/`, and its changed and untracked paths
        (`git -C <root> status --porcelain --untracked-files=all`) are a subset of the
        applied patch's paths. Then run `git worktree remove --force <root>`, and delete
        its branch (named in that listing; `git branch -d <branch>`) only if the branch
        tip equals the item's reported `baseSha`.
      - **`held`** (a `qualify` at L3 — the workflow never auto-applies one unattended):
        `HOLD`, set the node `escalated` with `missing` = "human approval of the qualifier:
        <qualifier>".
      - **`deferred`** (defer): `HOLD`, set the node `deferred`, copy the record's
        `missing` into the node. A defer whose `missing` names a human decision or approval
        (a denylist defer, or the verifier's "a human decision to change <contract>") makes
        the node `escalated` instead — the loop cannot supply it.
      - **`rejected`** (reject/revise/denylist): `HOLD`, set the node `escalated`; its
        `missing` = the record's `missing`, else its `repair`, else "a human decision on:
        <the record's reason>" — never empty.
      Keep the worktrees of deferred, held and escalated items (and of any applied item
      that was not CLEARed), and list them in the run-log entry. Before that entry, run
      `pnpm -s trace plan-lint` again: a node this step escalated may strand its dependents
      (cascade-resolve them now, as in step 9), and a fourth `loop:<id>` attempt escalates
      its node — an iteration never ends on a plan that fails it.
      Never fix nice-to-haves automatically; never start unrelated refactors.
    - **If no node is ready** after re-plan, do not invent work — **self-stop** (per
      *Stop when*).
11. **Append a run entry** to `.claude/memory/loop-run-log.md` (see format below). When the
    user later commits a node's change, a `Plan: LP-…` trailer in the commit message ties it to
    the node — an optional convention, never linted as an error.

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
`scripts/trace/` and the gate runner (every path under the root `scripts/` directory,
the root `package.json`, and the `vitest.config.*`, `playwright.config.*`,
`eslint.config.*` and `tsconfig.json` runner configs, since a one-line change to the
`test` script or to vitest's include could make `pnpm test` skip every `scripts/**`
gate): a loop never self-modifies its own instructions or gates
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
- The latest round's `completion.verdict` is `accept` (no blocker open, no lens failed),
  browser verification passes, relevant tests pass, and the current task has clear
  evidence of completion — or a stop condition above fires.
- Or every remaining claim has a terminal TRACE outcome (paper §5.4): **(1)** accepted/
  qualified and acted on, **(2)** rejected, **(3)** deferred with a named `missing` the loop
  cannot supply this run — report those `missing` lists as the human ask, or **(4)
  diminishing returns** — this iteration changed nothing that matters (no node changed
  status and no verdict changed versus the previous iteration — new records that merely
  repeat old verdicts do not count): stop and report rather than spin. An iteration whose
  critic round was incomplete (`error` set, or a failed lens) is never diminishing
  returns: re-run the round (infra re-runs count toward the budget).

## Run-log entry (append to `.claude/memory/loop-run-log.md`)
```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- node: <plan-item id acted on, or "none — report-only / no ready node">
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- re-plan: <nodes added / marked done / deferred→ready / dropped, or "none">
- records: <record ids written + actions (CLEAR/HOLD/REUSE), or "none">
- drift: <diff paths outside each node's scope, or none; plus `pnpm -s trace plan-drift` (advisory): nodes added/dropped/moved since the last entry>
- worktrees: kept <paths> | removed <n>
- budget: <used>/<cap> (turns or tokens)
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Each loop report must include: current task, trust level, localhost status, critic
matrix (with typed verdicts), fixes applied, TRACE records written (+ open defers and
their `missing`), browser evidence, test evidence, escalations, and remaining risks.
