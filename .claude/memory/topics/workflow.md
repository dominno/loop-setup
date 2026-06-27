# Workflow & docs

- `/dream` maintains this wiki: **ingest** new durable learnings into the right
  topic page at the end of a task, **query** it to answer "what do we know about
  X", and **lint** it for contradictions/stale/orphan pages. See
  `.claude/commands/dream.md`.
- `docs/prd.md` is the source of record for user stories; `docs/` holds the
  evidence-based story/status maps kept in sync by the doc-scanner commands.
- Custom commands live in `.claude/commands/` (each with a `description` for
  routing); the grouped "when to use" catalog is `.claude/skills-index.md`. A
  catalog file must NOT live in `.claude/commands/` — anything there auto-registers
  as its own `/command`.

Related: [build-and-verify](./build-and-verify.md) · [testing](./testing.md)
