# Memory Log

Append-only record of wiki operations. Newest entries at the bottom. Prefixes:
`ingest` (new learnings filed), `lint` (health-check), `migrate` (structure
change), `rotate` (archived old entries). Format: `## [YYYY-MM-DD] <op> | <summary>`.

> **Rotation:** when this file passes **500 lines**, `/dream lint` moves the older
> entries into yearly archives at `.claude/memory/log/<YYYY>.md` (created on demand)
> and leaves the recent entries here, then logs a `rotate` entry. Archives are read
> only when deep history is needed. This file is never `@imported`, so its size
> costs nothing per session — rotation is purely to keep reads/appends cheap.

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

## [2026-06-27] ingest | Skills-system + adoption edge-case learnings
- Added to topics/workflow.md: command `description` enables model auto-invocation
  (use `disable-model-invocation: true` for manual-only); team perms belong in
  committed `settings.json`, and git auto-allow is opt-in.
- Source: critic round on the skills-index changes + adoption-guide hardening
  (stale seeded facts, verify-chain trimming, name collisions, monorepo, import
  path, permissions).

## [2026-06-27] migrate | Added log rotation rule (>500 lines)
- `/dream lint` now rolls older entries into yearly archives
  `.claude/memory/log/<YYYY>.md` once this file passes 500 lines, keeping a recent
  window here. Documented in `index.md` and the log header. Lossless move; the log
  is never `@imported`, so this is about read/append cost, not session context.

## [2026-06-27] ingest | Let the agent write its own /goal
- Adopted the "agent writes its own /goal" principle (Boris Cherny): CLAUDE.md now
  has a "Writing /goal and /loop prompts" section (power-move offer + six-part goal
  checklist + 3 methods + triggers), a new `/write-goal` command, and a
  skills-index row. Filed the principle in topics/workflow.md.
- Source: audit of the template against the "/goal authoring" guidance.

## [2026-06-27] ingest | CI workflow learnings
- Added to topics/remote-env.md: CI (GitHub Actions) has no pre-provisioned
  browser, so it runs the normal `playwright install --with-deps chromium` (not the
  web env's SKIP flag); CI runs parallel jobs (matrix + e2e); `process.env.CI` makes
  Playwright start a fresh server.
- Source: adding `.github/workflows/verify.yml` (parallel-jobs CI).
