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
- **Critic rounds and the doc-scan run as deterministic multi-agent Workflows**, not
  one agent simulating critics: `.claude/workflows/critic-panel.js` (fan-out critics
  → adversarial verify → matrix) and `.claude/workflows/scan-docs.js` (per-story
  parallel evidence → separate status verifier). The critic commands invoke these
  via the Workflow tool (the sanctioned multi-agent opt-in). Name the workflow
  distinctly from any command (e.g. `critic-panel` vs the `/critic-round` command)
  to avoid a duplicate entry in the skills list.
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
