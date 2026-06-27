# Project Memory (durable learnings)

Curated, durable project knowledge. Imported into `CLAUDE.md` so it loads every
session. Maintained by the `/dream` command (see `.claude/commands/dream.md`).

Rules for this file:
- Only durable facts: stack, conventions, gotchas that stay true across tasks.
- No secrets, tokens, passwords, or API keys.
- No temporary/branch-specific bugs or one-off incidents.
- Prefer appending. Edits that remove or rewrite entries need explicit confirmation.
- Each entry should be a single, verifiable statement. Keep the file short.

## Environment & tooling
- Package manager is **pnpm** (no `package-lock.json`). Do not switch managers.
- Stack: **Next.js 16 (App Router) + React 19 + TypeScript 6**, **Vitest 4** for
  unit tests, **Playwright 1.56** for E2E. ESLint **9** with flat config.
- App URL is `http://localhost:3000`.

## Build & verify
- `pnpm verify` runs: typecheck → lint → unit → build → E2E.
- Next 16 **removed `next lint`**; `pnpm lint` runs `eslint .` directly.
- Use `eslint-config-next`'s **native flat config** in `eslint.config.mjs`
  (`import next from "eslint-config-next"`). Do **not** use `FlatCompat` — it
  crashes under ESLint 9 ("Converting circular structure to JSON").

## Testing conventions
- Unit/component tests live under `src/` (Vitest, `*.test.ts`); E2E specs live
  under `e2e/` (Playwright). They are scoped separately and run by different
  commands.
- In E2E, **do not** use a bare `getByRole('alert')`: Next injects a route
  announcer with `role="alert"`, causing strict-mode collisions. Target a
  specific `id`/`data-testid` (e.g. `#name-error`, `getByTestId('greeting')`).
- Playwright `webServer` auto-starts `pnpm dev` and reuses an already-running one.
- Each Playwright test runs in an isolated browser context, so `localStorage`
  starts empty per test; `page.reload()` preserves it within the same test.
- Unit-test browser globals in Vitest's node env with
  `vi.stubGlobal('localStorage', mock)` and `vi.unstubAllGlobals()` in teardown.

## Client components (React 19)
- ESLint (`react-hooks/set-state-in-effect`, on via `eslint-config-next`) errors
  on synchronous `setState` inside `useEffect`. To restore state from
  `localStorage`/an external store, use `useSyncExternalStore` with a `null`
  server snapshot — not `useEffect` + `setState`.
- `localStorage` writes do **not** fire the native `storage` event in the same
  tab (only other tabs). Dispatch a custom `window` event after writing so
  same-tab `useSyncExternalStore` subscribers re-read.
- Browser-API wrappers (e.g. `localStorage`) live in their own `src/lib` module,
  SSR-guarded (`typeof window`/`globalThis` checks); the pure domain rule
  (`greeting.ts`) stays DOM-free.

## Code organization
- Routes under `src/app`, API handlers under `src/app/api`, pure domain logic
  under `src/lib` (kept DOM-free and unit-tested), client components under
  `src/components`.

## Claude Code on the web (remote env)
- Chromium is pre-provisioned at `/opt/pw-browsers`; `PLAYWRIGHT_BROWSERS_PATH`
  is already set. Run installs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and do
  **not** run `playwright install`.
- Keep `@playwright/test` pinned to the version whose bundled Chromium matches the
  pre-provisioned build (currently **1.56.0 ↔ Chromium build 1194**). Bumping
  Playwright without a matching browser will fail in headless web sessions.
- Manual MCP browser verification is unavailable in headless web sessions (no
  Chrome/Playwright MCP attached); automated Chromium E2E is the verification path.

## Workflow notes
- `/dream` consolidates new durable learnings into this file at the end of a task.
- `docs/prd.md` is the source of record for user stories; `docs/` holds the
  evidence-based story/status maps kept in sync by the doc-scanner commands.
