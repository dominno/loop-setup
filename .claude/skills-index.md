# Commands (skills) index

Catalog of the custom slash commands in `.claude/commands/`, grouped by purpose,
with **when to use** each. This mirrors the memory wiki's `index.md`: a small
catalog so both you and Claude can route to the right command.

> This file lives at `.claude/skills-index.md` (NOT inside `.claude/commands/`) on
> purpose — a file in `commands/` would auto-register as its own `/command`.
>
> Claude also routes natively from each command's `description` frontmatter. This
> index is the human-readable, grouped view and the canonical "when to use" guide.
> Keep it in sync when commands are added or changed (the `/dream` command does
> this during its `lint`/`ingest` passes).

## Pick by intent
- **Start a non-trivial task — let Claude write the goal** → `/write-goal`
- **Build or change something non-trivial** → `/multi-agent-dev`
- **Just review, don't change code** → `/critic-round`
- **Add/expand end-to-end tests** → `/multi-agent-e2e`
- **localhost is broken** → `/fix-localhost`
- **About to commit/ship** → `/qa-pass`
- **Map what's built vs documented vs tested** → `/scan-project-docs`, then
  `/sync-story-status`, `/story-gap-analysis`
- **Capture/curate what was learned** → `/dream`, `/memory-audit`
- **Keep watching localhost on an interval** → `/loop` (uses `.claude/loop.md`;
  gate trust level with `.claude/loop-checklist.md`, state in
  `.claude/memory/loop-run-log.md`)

## Development loop
| Command | When to use | Args |
|---|---|---|
| `/write-goal` | Start of a non-trivial task: turn a described outcome into a production-grade `/goal` (or `/loop`) prompt to review and run | `[outcome]` (say "loop" for a /loop) |
| `/multi-agent-dev` | Default for any non-trivial feature, bug fix, or UI change; ends with browser + test evidence | `[task]` |
| `/critic-round` | Read-only review of the current app/flow; returns a findings matrix, changes no code | `[focus]` |
| `/multi-agent-e2e` | A user flow needs new or expanded Playwright E2E coverage | `[target flow]` |
| `/qa-pass` | Final pre-ship gate before committing a change set | `[scope]` |
| `/fix-localhost` | Dev server or localhost is broken / throwing on load | — |

## Product-delivery audit
| Command | When to use | Args |
|---|---|---|
| `/scan-project-docs` | First audit, or after product docs change significantly; builds the `docs/` story map | `[scope]` |
| `/sync-story-status` | After implementing/testing stories, to refresh statuses with evidence | `[scope]` |
| `/story-gap-analysis` | Assessing MVP readiness or deciding what to build/test next (read-only) | `[scope]` |

## Memory & self-learning
| Command | When to use | Args |
|---|---|---|
| `/dream` | End of a non-trivial task: ingest durable learnings into the wiki, lint it, and propose new skills | `[ingest \| query <q> \| lint]` |
| `/memory-audit` | Periodically prune stale/duplicated/misleading memory (no deletes without confirmation) | — |

## Conventions for adding a command
- Every command needs a one-line `description` frontmatter (used for routing) and,
  if it takes input, an `argument-hint`.
- Add a row to the right group above. `/dream lint` flags commands missing a
  description or an index row.
- Prefer extending an existing command over adding a near-duplicate.
