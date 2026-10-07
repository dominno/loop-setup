# Workflow & docs

- `/dream` maintains this wiki: **ingest** new durable learnings into the right
  topic page at the end of a task, **query** it to answer "what do we know about
  X", and **lint** it for contradictions/stale/orphan pages. See
  `.claude/commands/dream.md`.
- `docs/prd.md` is the source of record for user stories; `docs/` holds the
  evidence-based story/status maps kept in sync by the doc-scanner commands.
- **User stories are one file per story** under `docs/stories/US-<id>-<slug>.md`
  (copy `docs/stories/_TEMPLATE.md`); `docs/user-stories.md` is the index and
  `docs/implementation-status.md` is the evidence dashboard. Don't pile stories into
  one file — same scaling reason as the memory wiki and log.
- **Loops are hardened ("loop engineering"):** every `/loop` declares a trust level
  (L1 report → L2 assisted → L3 unattended), reads/writes
  `.claude/memory/loop-run-log.md`, and obeys the denylist + red-flag stop
  conditions in `.claude/loop.md`. Raise a level only after `.claude/loop-checklist.md`
  passes. The verifier pass is always separate from the implementer (no self-approve).
- **The loop is HTDAG-disciplined:** it traces every action to a durable plan/DAG in
  `.claude/memory/loop-plan.md` — typed nodes with `after:` dependency edges and a
  `ready` rule (deps `done`). Three disciplines: (1) **persistent plan** the loop reads
  at iteration start (step 1) and rewrites in the re-plan step; (2) **re-plan is a
  first-class step** that runs *before* dispatch (step 9) so the loop consults the fresh
  DAG every iteration; (3) **no action without a node** — every L2/L3 dispatch is a ready
  plan node, and node creation is the *only* action exempt (the sanctioned bootstrap, so
  an empty plan populates rather than deadlocks). Readiness never bypasses the denylist
  or trust level — those gates stay on top. `loop-plan.md` = current mutable plan;
  `loop-run-log.md` = append-only history — keep them distinct. **DAG-contract lesson**
  (from the checker round): a deterministic readiness rule must classify *every* persisted
  status (exclude `in-progress`, or a crash-orphaned node re-reads as ready → duplicate
  dispatch) and resolve *every* non-`done` terminal dep-state (a `dropped`/`escalated`
  dependency must cascade-resolve, else its dependents strand silently `blocked`).
- **Verdicts are typed and recorded (TRACE-lite):** every verdict-producing workflow
  (`critic-panel`, `loop-iteration`, `improve-skills`, `scan-docs`) returns
  accept/qualify/revise/defer/reject plus `traceRecords` drafts; the caller appends them
  with `pnpm trace write`, and a node/fact/story status changes only with a licensing
  record + consumer action. Shared deterministic blocks (evidence gate, denylist, loop
  verifier prompt, critic roster) are byte-identical copies across workflows, enforced by
  `scripts/trace/contracts.test.mjs`. Details: [trace](./trace.md).
- Custom commands live in `.claude/commands/` (each with a `description` for
  routing); the grouped "when to use" catalog is `.claude/skills-index.md`. A
  catalog file must NOT live in `.claude/commands/` — anything there auto-registers
  as its own `/command`.
- **Fan-out commands run as deterministic multi-agent Workflows** under
  `.claude/workflows/`, not one agent simulating critics: `critic-panel` (critics →
  adversarial verify → matrix), `scan-docs` (per-story evidence → status verifier),
  `gap-analysis` (per-dimension gaps → synth order), `e2e-design` (per-category
  cases → dedup), `loop-iteration` (worktree implementer → separate verifier),
  `improve-skills` (per-lens meta-critic over our OWN prompts/workflows → proposed
  edits, confirmation-gated), `trace-bench` (measures the checkers on seeded-defect
  fixtures, `/bench-checkers`). Commands invoke them via the Workflow tool (the
  sanctioned opt-in). Name a workflow
  distinctly from any command (e.g. `critic-panel` vs the `/critic-round` command) to
  avoid a duplicate skills-list entry. Don't force non-fan-out commands
  (`/fix-localhost`, `/write-goal`, `/dream`, `/memory-audit`) into workflows.
- **Self-improvement vs self-learning (two axes).** `/dream` improves what the system
  *knows* (curates the memory wiki — facts); `/improve-skills` improves the *machinery*
  (a meta-critic Workflow that reviews the project's OWN command/workflow prompts and
  proposes tightenings). Both are confirmation-gated: never auto-create, rewrite, or
  delete a command/skill, and never weaken an instruction or remove a safety gate as
  an "improvement". `/improve-skills` is `disable-model-invocation: true` (manual-only)
  because it edits core prompts; its verifier judges a finding on *two* axes — is the
  problem **real** and is the proposed edit **safe** (won't weaken instruction-following
  or break a workflow) — and only real-and-safe findings are `applyReady`.
- **A self-improving system must add its OWN prompt surface to every autonomous
  denylist.** The loop's deterministic gate (`loop-iteration.js` DENYLIST) and prose
  denylist (`loop.md`) both include `.claude/` and `CLAUDE.md`, so an L2/L3 loop can
  never autonomously rewrite the rules that constrain it — it escalates instead. The
  only sanctioned way to change the prompt surface is the manual, confirmation-gated
  `/improve-skills`. (Found by the first `/improve-skills` run, on its own machinery.)
- Workflow scripts use a DSL (`agent()/parallel()/pipeline()/phase()`, top-level
  `await`/`return`); validate syntax by wrapping the body in `async function(){…}`
  before `node --check` (bare `node --check` reports a false "illegal return").
  Make verifier agents **fail safe** (a null/failed verdict must NOT confirm), give
  parallel agents **unique labels** that **always include the map index** (so
  duplicate caller-supplied ids can't collide — `${id || 'x'}-${i}`, not `${id||i}`),
  and provide **fallback strings** for schema-required fields. Also guard the
  *first* pipeline stage's result before deref (`const ev = stage1 || {}`), fail
  **closed** (don't accept a maker's self-proposed value when the checker is
  missing), and give a maker/checker checker the **real artifact** (the diff), not
  the maker's self-report. The DSL auto-caps concurrency (~min(16, cores-2)), so a
  large fan-out won't spawn unbounded agents — no manual limit needed.
- **Model tiering (graph-engineering): fan-out → fast tier, gate → strong tier.**
  High-volume, individually-low-stakes fan-out nodes (critics, per-story evidence,
  per-dimension gaps, per-category E2E cases) run `model: 'sonnet'`; the high-stakes
  gates/judgment (adversarial verifiers, status verifier, synthesis) run
  `model: 'opus'`. Define `FANOUT_MODEL`/`JUDGE_MODEL` constants (default `sonnet`/
  `opus`, overridable via `args.models = { fanout, judge }`) and pass `model:` per
  `agent()`. **Exception:** a node that writes real code (the `loop-iteration`
  implementer) inherits the session model — never silently downgrade a code-writing
  node. This cuts cost on the wide fan-out and keeps quality where the decision is made.
- **Budget as soft + hard control.** For big fan-outs, guard on `budget.total` (it is
  `null` when no target was set — without the guard `budget.remaining()` is `Infinity`
  and a loop never stops). Hard-stop pattern: if `budget.total && budget.remaining()
  < FLOOR`, skip the expensive stage instead of failing mid-run — `loop-iteration`
  escalates all items (`budgetStopped`), `improve-skills` skips the verify fan-out and
  returns the findings as `deferred` (TRACE `defer`: unverified ⇒ never auto-applied,
  never counted as refuted). Keep the fail-safe
  direction: a budget stop must never *approve* unverified work.
- **Diagram-first:** every workflow's node/edge graph is drawn in
  `docs/workflow-graphs.md` (Mermaid), with the model tier per node. Update the diagram
  when you add a node, edge, or change a tier — `/improve-skills` and `/dream lint`
  flag drift between a diagram and its script.
- A command's `description` also lets Claude **auto-invoke** it. Add
  `disable-model-invocation: true` to heavy/code-changing commands that should be
  manual-only.
- Team-wide permissions belong in committed `.claude/settings.json`;
  `.claude/settings.local.json` is conventionally personal (often git-ignored).
  Auto-allowing `git commit`/`git add` lets the agent commit without a prompt — opt
  in deliberately.
- **Let the agent write its own `/goal`/`/loop`.** When the user describes a
  non-trivial task, first offer to write the `/goal` prompt (`/write-goal`). Every
  `/goal` must carry six things: one-line task, 3–5 measurable success criteria,
  constraints, checkpoint rules (pause vs run-through), a self-verify instruction,
  and a max-budget/turn guard. See `CLAUDE.md` → "Writing `/goal` and `/loop`
  prompts".
- Cost (one run, scales with the number of blocker/important findings): an
  `/improve-skills` pass over 21 prompt/workflow files spawned 112 agents (~9.4M subagent
  tokens, ~82 min) because every blocker/important finding gets its own strong-tier
  verifier — scope `args.targets` narrowly when budget matters. <!-- rec:TR-6ab38b2e15ac -->

Related: [build-and-verify](./build-and-verify.md) · [testing](./testing.md) · [trace](./trace.md)
