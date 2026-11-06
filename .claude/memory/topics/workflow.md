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
- A `scan-docs` story record's `claim_text` names the PROPOSED status (`is at status "<S>"`);
  when the status verifier held it lower, the record is `qualify` and its qualifier names the
  status it licenses (`holds only at "<S>"`). `pnpm trace story-lint` rule (7) reads those two
  phrases, so a story cites a qualify record at the lower status. <!-- rec:TR-ef509b55013d -->
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
- **Verdicts are typed and recorded (TRACE-lite):** `critic-panel`, `loop-iteration`,
  `improve-skills` and `scan-docs` return accept/qualify/revise/defer/reject plus
  `traceRecords` drafts that the caller appends with `pnpm trace write`; `e2e-design` and
  `gap-analysis` type every case or gap with the same verdicts but return no records (their
  verdicts are advisory), and a `trace-bench` run becomes one record only through
  `pnpm trace bench-score --record`. A node/fact/story status changes only with a licensing
  record + consumer action; the shared deterministic blocks (evidence gate, denylist, loop
  verifier prompt, critic roster, agent safety) are byte-identical copies, enforced by
  `scripts/trace/contracts.test.mjs`. Details: [trace](./trace.md). <!-- rec:TR-5f79a159395f -->
- Custom commands live in `.claude/commands/` (each with a `description` for
  routing); the grouped "when to use" catalog is `.claude/skills-index.md`. A
  catalog file must NOT live in `.claude/commands/` — anything there auto-registers
  as its own `/command`.
- **Fan-out commands run as deterministic multi-agent Workflows** under
  `.claude/workflows/`, not one agent simulating critics: `critic-panel` (critics →
  adversarial verify → matrix), `scan-docs` (per-story evidence → status verifier),
  `gap-analysis` (per-dimension finders → a separate skeptic per dimension → an order over
  the licensed gaps only), `e2e-design` (per-category cases → dedup → a separate judge;
  only licensed cases are returned), `loop-iteration` (worktree implementer → separate
  verifier), `improve-skills.js` (skill `prompt-meta-critic`: per-lens meta-critic over our
  OWN prompts/workflows → proposed edits, confirmation-gated) and `trace-bench` (measures
  the checkers on seeded-defect fixtures, `/bench-checkers`). Commands invoke them via the
  Workflow tool (the sanctioned opt-in). A workflow's `meta.name` differs from every
  command's name (e.g. `critic-panel` vs `/critic-round`): workflows and commands share the
  skills list. Don't force non-fan-out commands (`/fix-localhost`, `/write-goal`, `/dream`,
  `/memory-audit`) into workflows. <!-- rec:TR-79ad595a532b -->
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
  provide **fallback strings** for schema-required fields, fail **closed** (don't accept
  a maker's self-proposed value when the checker is missing), and give a maker/checker
  checker the **real artifact** (the diff), not the maker's self-report.
  <!-- rec:TR-53a3ffad47a3 -->
- In the Workflow engine a `pipeline()` stage that resolves to `null` (or throws) ends that
  item: its later stages never run and its slot is `null` (Claude Code 2.1.316; not a
  documented API). So every `agent()` starts inside `then()` with
  `.catch(agentFailed(label))`, a first stage whose agent may die wraps its result, and a
  `null` slot is filled or read as a failure — never dropped with `filter(Boolean)`
  (*Adding a workflow* in `docs/workflow-graphs.md`). <!-- rec:TR-aea448fee314 -->
- A workflow runs at most 2 agents at once in this 4-CPU cloud container (consistent with
  min(16, CPUs − 2)); three workflows launched together ran 6 at once (2026-10-31). That
  bounds parallelism, not cost — the cost bounds are the per-call caps (`critic-panel`
  maxVerifiers 30, `scan-docs` maxStories 30, `loop-iteration` maxItems 5) and the budget
  floors. <!-- rec:TR-34466b07a374 -->
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
- A command's `description` also lets Claude **auto-invoke** it.
  `disable-model-invocation: true` stops that but also blocks Claude's Skill call, so a
  command is manual-only only if it rewrites the governing prompt surface or runs a measured
  fan-out `CLAUDE.md` never asks for (today `/improve-skills` and `/bench-checkers`), marked
  `(manual-only)` in its `.claude/skills-index.md` row; `pnpm test` fails when a flag and its
  row disagree. <!-- rec:TR-dc21201014e2 -->
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
- Cost reference (one run each; critic-panel cost scales with its blocker/important
  findings — 24 here): a critic-panel round with the 5 non-UI critics spawned 29 agents
  (~2.9M subagent tokens, ~51 min); TRACE-Bench-lite (verifier + single-pass, repeat 2,
  11 fixtures) spawned 33 agents (~2.0M tokens, ~10 min). <!-- rec:TR-3ef3eac264d4 -->
- Cost (one run): TRACE-Bench-lite with verifier (repeat 2) + single-pass + a 5-critic
  panel over 19 fixtures spawned 152 agents (~9.5M subagent tokens, ~59 min); the panel arm
  (~5 agents per fixture) dominates. <!-- rec:TR-7085756f8495 -->
- Cost (one run): a verifier-only TRACE-Bench-lite run at repeat 3 over 29 fixtures spawned
  87 agents (~5.8M subagent tokens, ~49 min); each verifier applies the diff and runs the
  repo's checks, so cost tracks the verify chain's runtime. <!-- rec:TR-57403effdd24 -->
- Workflow subagent transcripts indent every line after the first of the agent's prompt
  (its first user message) by two spaces — strip `\n  ` before checking that a prompt
  carries an exact args string, e.g. a bench patch (observed 2026-10-08).
  <!-- rec:TR-b3b37a1408f4 -->

Related: [build-and-verify](./build-and-verify.md) · [testing](./testing.md) · [trace](./trace.md)

## Not adopted (plan)
Borrowings the planning research and critic council (docs/plans/planning-upgrade/) weighed
for `loop-plan.md` and turned down. Each says what would reopen it, so this is not permanent.
- **JSON plan / feature list** — the markdown table plus `pnpm trace plan-lint` already
  fails closed on a malformed edit, and the TRACE records hold the verdicts. Reopen when
  plan-lint misses a hand-edit corruption that a JSON schema would have caught.
- **epic/parent containers** (a hierarchy column or nested ids) — a parent row would be one
  more status nobody dispatches; as-needed decomposition is covered by the split convention
  (`loop-plan.md`, *Split on failure*: a dropped parent with a `split into` trail). Reopen when a real plan needs a rollup that a story token
  and `pnpm trace status` cannot give.
- **A numeric complexity score** — a same-model guess with no ground truth; size is derived
  from the `scope` column instead. Reopen when measured split rates show scope counts
  mis-size nodes.
- **A new node status** (e.g. `split`, `claimed`, `review`) — every status must be classified
  by the ready rule and the cascade rules; extra ones multiply that. Reopen when an existing
  status plus a notes token cannot express a real case.
- **bd-style commands** (`ready`, `claim`, `close`) — `pnpm trace plan-ready`, `plan-lint`
  and `plan-items` cover them; the plan is edited by the Lead. Reopen when two people need
  an atomic claim that the commit-and-push lease cannot give.
- **Bench re-run rule:** a `PLAN_COLUMNS` change alone needs no `/bench-checkers` re-run (it
  must update `PLAN_COLUMNS`, the Node schema table and the parser tests together); a change
  to the plan-items item shape, or to the text the loop verifier receives, does.

