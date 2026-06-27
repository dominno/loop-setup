# Memory Log

Append-only record of wiki operations. Newest entries at the bottom. Prefixes:
`ingest` (new learnings filed), `lint` (health-check), `migrate` (structure
change). Format: `## [YYYY-MM-DD] <op> | <summary>`.

## [2026-06-27] ingest | Initial durable learnings
- Seeded tooling, build & verify, testing, code organization, remote-env, and
  workflow facts from the loop-setup and starter-app work.

## [2026-06-27] ingest | US-002 "remember me" learnings
- Added `useSyncExternalStore`/hydration + same-tab `storage` event +
  SSR-guarded `src/lib` wrapper facts → topics/client-react.md.
- Added Playwright per-test `localStorage` isolation + `vi.stubGlobal` facts →
  topics/testing.md.

## [2026-06-27] migrate | Adopt Karpathy LLM-wiki structure
- Replaced the single `.claude/memory.md` with `index.md` + `topics/*` + this
  `log.md`. No facts removed; each former section became a topic page.
- `CLAUDE.md` now imports only `.claude/memory/index.md` (small, always-loaded);
  topic pages are read on demand to keep per-session context flat as memory grows.

## [2026-06-27] lint | First health-check of the wiki
- Index ↔ topics in sync (7/7 rows resolve); no broken cross-links, no
  contradictions, no stale claims.
- Fixed one semi-orphan: `topics/workflow.md` had no inbound cross-links from
  sibling pages. Added reciprocal links between `workflow.md` and
  `build-and-verify.md`. Every page now has an inbound link beyond the index.
