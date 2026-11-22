# Claude Code on the web (remote env)

- Chromium is pre-provisioned at `/opt/pw-browsers`; `PLAYWRIGHT_BROWSERS_PATH`
  is already set. Run installs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and do
  **not** run `playwright install`.
- `@playwright/test` is pinned to **1.63.0**. Its `browsers.json` names Chromium (and headless
  shell) build **1243** and ffmpeg 1011, which is what the container image ships in
  `/opt/pw-browsers`, so `pnpm test:e2e` runs with no shim. The image's build can change
  (1194 before 2026-11-06, 1243 since). The pinned version alone picks the build, so when the image
  moves, read the new build off each candidate's `browsers.json` (`npm pack playwright-core@<v>`)
  and move the pin. CI installs its own browser. <!-- rec:TR-ec03808b5b04 -->
- Manual MCP browser verification is unavailable in headless web sessions (no
  Chrome/Playwright MCP attached); automated Chromium E2E is the verification path.
- **CI is different from the web env:** GitHub Actions has no pre-provisioned
  browser, so the CI workflow (`.github/workflows/verify.yml`) runs the normal
  `pnpm exec playwright install --with-deps chromium`. Do NOT use
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` in CI. CI runs checks as parallel jobs
  (`typecheck`/`lint`/`test`/`build` matrix + separate `e2e`); `process.env.CI`
  makes Playwright start a fresh server instead of reusing one.

- **pnpm version gotcha:** CI pins **pnpm 10** (`pnpm/action-setup@v4`, `version: 10`), but
  the web env's default `corepack pnpm` is newer (12.21.0 on 2026-11-22).
  - pnpm 11 fails `install --frozen-lockfile` with `ERR_PNPM_IGNORED_BUILDS` on unapproved native
    builds (sharp, unrs-resolver). pnpm 10 only lists them as "Ignored build scripts".
  - When adding a dependency, approve its builds in `pnpm-workspace.yaml`
    (`onlyBuiltDependencies:`).
  - Regenerate the lockfile with `CI=true corepack pnpm@10 install --no-frozen-lockfile`.
    `CI=true` alone means `--frozen-lockfile`, so after a manifest change it refuses with
    "specifiers in the lockfile don't match".
  - Run local checks with `CI=true corepack pnpm@10 …`. <!-- rec:TR-05757f216432 -->
- Subagent test runs in scratch copies can outlive their agent: after heavy workflow runs,
  orphaned vitest workers (PPID 1, cwd a deleted scratch directory) kept 2 of this
  container's 4 CPUs at ~99% for hours (observed once, 2026-10-31). Find them with
  `ps -eo pid,ppid,pcpu,args` and `readlink /proc/<pid>/cwd`, and remove them by PID only.
  <!-- rec:TR-feb3bd831b17 -->
- Observed 2026-11-22 (one container; the image can change again): `/opt/pw-browsers` held
  `chromium-1243`, `chromium_headless_shell-1243` and `ffmpeg-1011`.
  - On Playwright 1.63.0, `pnpm test:e2e` passed 16/16 with no shim.
  - On 1.56.0, 15 of 16 tests failed with "Executable doesn't exist …
    chromium_headless_shell-1194/chrome-linux/headless_shell".
  - While the pin and the image disagree, a scratchpad `PLAYWRIGHT_BROWSERS_PATH` that maps the
    expected path to the image's `chrome-headless-shell-linux64/chrome-headless-shell` (plus
    `ffmpeg-1011`) bridges them with no repo change.
  <!-- rec:TR-1ff807be9596 -->
- A kit installed into `~/.claude` by the environment **setup script** (it runs before Claude
  starts) is loaded by a fresh web session: its user-scope commands in `~/.claude/commands` are
  available as skills, and its SessionStart hook in `~/.claude/settings.json` runs, even though
  the runtime writes its own `~/.claude/launcher-settings.json` with its own SessionStart/Stop
  hooks. Check with `stat -c %w ~/.claude/loop-setup/installed.json` (it predates the session
  transcript) and `loop-setup doctor`. <!-- rec:TR-1a9be639eba8 -->
- The runtime also runs the kit's Stop hook (`loop-setup hook stop`, owned in `~/.claude/settings.json`)
  when a turn ends: with unsynced workspace state it blocks, and its reason comes back to the agent
  verbatim as "Stop hook feedback: The loop workspace <id> has unsynced state (N changed file(s), M
  unpushed commit(s)). Run `loop-setup sync` …" (logged as a `hook_blocking_error` attachment in the
  session transcript). Observed in a cloud session (2026-11-22) with the kit installed by the setup
  script; it blocks at most once per turn — it returns no decision when the stop is already a
  Stop-hook continuation (`stop_hook_active`). <!-- rec:TR-6eab59a1408c -->
- A cloud session can start on a container saved from an earlier boot: the setup-script kit
  install, the loop workspace and the local `main` ref then date from that boot, while the checkout
  is moved to current `origin/main`. Observed once (2026-11-22): `installed.json` named an
  ancestor of `origin/main`, and the workspace was 13 commits behind. Compare `source.commit` with
  `git rev-parse origin/main` before trusting the kit. <!-- rec:TR-527aeb7cfe23 -->

Related: [tooling](./tooling.md) · [testing](./testing.md) · [build-and-verify](./build-and-verify.md)
