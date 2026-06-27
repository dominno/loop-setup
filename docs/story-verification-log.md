# Story Verification Log

Evidence log of checks that were actually run. Only record checks Claude truly
performed — command output, test runs, and browser observations. This log is the
required evidence trail before any story can be marked `Done`.

| Date | Story ID | Check performed | Command / action | Result | Notes |
|---|---|---|---|---|---|
| 2026-06-27 | US-001 | Typecheck | `pnpm typecheck` | Pass (exit 0) | tsc --noEmit clean |
| 2026-06-27 | US-001 | Lint | `pnpm lint` | Pass (exit 0) | eslint flat config (next) clean |
| 2026-06-27 | US-001 | Unit tests | `pnpm test` | Pass | 7/7 in `src/lib/greeting.test.ts` |
| 2026-06-27 | US-001 | Build | `pnpm build` | Pass | Next 16 production build, routes `/`, `/api/health` |
| 2026-06-27 | US-001 | E2E | `pnpm test:e2e` | Pass | 5/5 (smoke + happy/failure/recovery) on Chromium |
| 2026-06-27 | US-001 | E2E (regression caught) | `pnpm test:e2e` (initial run) | Found + fixed | `getByRole('alert')` collided with Next route-announcer; tightened selector to `#name-error` |

## What counts as evidence

- A test command and its pass/fail output (e.g. `pnpm test:e2e auth` passed).
- A browser observation on localhost (URL, flow tested, console state, network state).
- A typecheck/lint/build result tied to the story.

Do not log assumptions or "looks okay". Log only verifiable checks.
