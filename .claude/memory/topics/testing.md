# Testing conventions

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
- Vitest runs test files in parallel by default (`fileParallelism: true`), so a test must
  never mutate tracked sources that other test files read (e.g. apply a patch to `src/`);
  use a throwaway untracked file instead. <!-- rec:TR-462e7e971072 -->

Related: [client-react](./client-react.md) · [build-and-verify](./build-and-verify.md)
