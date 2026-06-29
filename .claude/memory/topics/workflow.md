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
  edits, confirmation-gated). Commands invoke them via the Workflow tool (the
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

Related: [build-and-verify](./build-and-verify.md) · [testing](./testing.md)
