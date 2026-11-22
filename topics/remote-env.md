# Claude Code on the web (remote env)

- Chromium is pre-provisioned at `/opt/pw-browsers`; `PLAYWRIGHT_BROWSERS_PATH`
  is already set. Run installs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and do
  **not** run `playwright install`.
- `@playwright/test` is pinned to **1.56.0**, which launches Chromium build **1194**; the
  pre-provisioned build is a property of the container image (1194 earlier, 1243 on
  2026-11-06). A mismatch shows as "Executable doesn't exist … -1194": bridge it with the
  scratchpad `PLAYWRIGHT_BROWSERS_PATH` shim below, not by bumping Playwright (CI pins its
  own browser). <!-- rec:TR-1a2a7cac54bb -->
- Manual MCP browser verification is unavailable in headless web sessions (no
  Chrome/Playwright MCP attached); automated Chromium E2E is the verification path.
- **CI is different from the web env:** GitHub Actions has no pre-provisioned
  browser, so the CI workflow (`.github/workflows/verify.yml`) runs the normal
  `pnpm exec playwright install --with-deps chromium`. Do NOT use
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` in CI. CI runs checks as parallel jobs
  (`typecheck`/`lint`/`test`/`build` matrix + separate `e2e`); `process.env.CI`
  makes Playwright start a fresh server instead of reusing one.

- **pnpm version gotcha:** CI pins **pnpm 10** (`pnpm/action-setup@v4`, `version: 10`),
  but the web/remote-env `corepack pnpm` is **11**, which errors `ERR_PNPM_IGNORED_BUILDS`
  on native deps (sharp, unrs-resolver) that pnpm 10 tolerates. When adding a dependency:
  approve builds in `pnpm-workspace.yaml` (`onlyBuiltDependencies:`), and regenerate the
  lockfile with `CI=true corepack pnpm@10 install` so it matches CI's `--frozen-lockfile`.
  Run local checks with `CI=true corepack pnpm@10 …` to avoid the pnpm-11 strictness.
- Subagent test runs in scratch copies can outlive their agent: after heavy workflow runs,
  orphaned vitest workers (PPID 1, cwd a deleted scratch directory) kept 2 of this
  container's 4 CPUs at ~99% for hours (observed once, 2026-10-31). Find them with
  `ps -eo pid,ppid,pcpu,args` and `readlink /proc/<pid>/cwd`, and remove them by PID only.
  <!-- rec:TR-feb3bd831b17 -->
- Observed 2026-11-06 (one container; the image can change again): `/opt/pw-browsers` held
  Chromium build **1243**, not the 1194 that the pinned Playwright 1.56.0 launches, so
  `pnpm test:e2e` failed with "Executable doesn't exist … headless_shell-1194". A scratchpad
  `PLAYWRIGHT_BROWSERS_PATH` with `chromium_headless_shell-1194/chrome-linux/headless_shell`
  symlinked to the 1243 binary (plus `ffmpeg-1011`) passed all 16 E2E tests with no repo change.
  <!-- rec:TR-e7829fbc9fc1 -->
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
