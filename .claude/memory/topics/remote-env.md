# Claude Code on the web (remote env)

- Chromium is pre-provisioned at `/opt/pw-browsers`; `PLAYWRIGHT_BROWSERS_PATH`
  is already set. Run installs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and do
  **not** run `playwright install`.
- Keep `@playwright/test` pinned to the version whose bundled Chromium matches the
  pre-provisioned build (currently **1.56.0 ↔ Chromium build 1194**). Bumping
  Playwright without a matching browser will fail in headless web sessions.
- Manual MCP browser verification is unavailable in headless web sessions (no
  Chrome/Playwright MCP attached); automated Chromium E2E is the verification path.
- **CI is different from the web env:** GitHub Actions has no pre-provisioned
  browser, so the CI workflow (`.github/workflows/verify.yml`) runs the normal
  `pnpm exec playwright install --with-deps chromium`. Do NOT use
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` in CI. CI runs checks as parallel jobs
  (`typecheck`/`lint`/`test`/`build` matrix + separate `e2e`); `process.env.CI`
  makes Playwright start a fresh server instead of reusing one.

Related: [tooling](./tooling.md) · [testing](./testing.md) · [build-and-verify](./build-and-verify.md)
