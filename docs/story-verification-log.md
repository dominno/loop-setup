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
| 2026-06-27 | US-001 | E2E (boundary edge cases added) | `pnpm test:e2e` | Pass | 7/7 — added 41-char rejection and 40-char acceptance; closes the max-length E2E gap |
| 2026-06-27 | US-002 | Doc scan + code-evidence search | `grep -rniE "localstorage\|persist\|remember\|clear" src/ e2e/` | No matches | Extracted from `docs/prd.md#52`; marked `Not started` — documented but not implemented |
| 2026-06-27 | US-002 | Implement + unit tests | `pnpm test` | Pass | 13/13 (added 6 cases in `src/lib/rememberedName.test.ts`) |
| 2026-06-27 | US-002 | Lint (caught react-hooks issue) | `pnpm lint` | Found + fixed | `react-hooks/set-state-in-effect` flagged the useEffect hydration; refactored to `useSyncExternalStore` |
| 2026-06-27 | US-002 | Full verify incl. E2E | `pnpm verify` | Pass | 11/11 E2E; AC1–AC5 covered in `e2e/remember-me.spec.ts`; US-001 regression green |

## What counts as evidence

- A test command and its pass/fail output (e.g. `pnpm test:e2e auth` passed).
- A browser observation on localhost (URL, flow tested, console state, network state).
- A typecheck/lint/build result tied to the story.

Do not log assumptions or "looks okay". Log only verifiable checks.
