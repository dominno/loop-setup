# Phase C run report (goals C3–C7)

One section per goal: commits, evidence (each command with its exit status and summary line),
the critic matrix and the remaining risks. The goals are specified in `goals.md`; each goal's
design and steps are in its own `docs/plans/<slug>/steps.md`.

**Pre-flight for this run.** `loop-setup verify-kit` exits 2 (`unknown command "verify-kit"`): the
kit in this container was installed from 2dd64dd (PR #20), before `verify-kit` existed (84f6395),
and the installer refuses to upgrade the session's own Claude home from inside Claude Code (a
human's step). The user waived `verify-kit` for C3–C7 in this session; the pre-flight is
`loop-setup doctor` with no fail. Each goal's section quotes it.

## C3 — the workspace's git dir outside the workspace, planted git config refused

Design and steps: `docs/plans/state-gitdir/steps.md` (approved by the user at the checkpoint, then
revised with the pre-implementation round's five findings before any code).

Pre-flight: `loop-setup doctor` exit 0 (10 ok, 0 fail).

Commits: ea055dd (S01–S05), 81b72fc (S03.1: `core.autocrlf=false`).

Success criteria and evidence:
1. **Layout and migration.** New and restored workspaces keep their GIT_DIR at
   `~/.claude/loop-setup/state/<id>.git`; the workspace has no `.git`, and the git dir is outside the
   `additionalDirectories` grant (`staterepo.test.mjs`, "init puts it at state/<id>.git…", which
   also checks `core.bare=false`, no `core.worktree`, a clean status, and no temporary git dir left).
   Old-layout workspaces move at their next sync ("sync moves <ws>/.git…": the same HEAD,
   `git log` and remote-tracking ref) or restore ("restore of a workspace already here…"), on real
   git. A poisoned old git dir (`commondir`, `config.worktree`, alternates, `info/attributes`,
   hooks) is rebuilt without any of them, and no payload runs.
2. **Explicit dirs, refusals.** Every state git call is `git --git-dir=… --work-tree=…` plus `HARDEN`
   after the guard (`stateGit`); only the bootstrap calls (init, clone, the first checkout) skip the
   work-tree rules, and those are checked by `incomingTreeRefusal` and the config/entry rules. Planted,
   one test each with a marker payload: root `.gitattributes`, nested `.gitattributes`, `.gitmodules`,
   `info/attributes`, `filter.*`, `diff.*.textconv`, `merge.union.driver`, `core.hooksPath`,
   `core.fsmonitor`, `include.path`, `commondir`, `config.worktree`. Each case: `sync` exits 2 naming
   the cause, `doctor` exits 1 with the cause, the Stop hook blocks with it, SessionStart says
   "State repo refused", and the marker directory stays empty. Controls show the payloads fire under
   plain git. A planted `.gitattributes` pushed to `claude/loop-state` is refused before the merge
   (sync) and before the checkout (restore).
3. **Unchanged for the user.** `lifecycle.test.mjs` is green (its one state-repo probe now names
   `--git-dir`, as the repo moved by design; the assertion is unchanged). New-layout and migrated
   workspaces: SessionStart reports unsynced state and the Stop hook blocks exactly as before.

Commands (HEAD 81b72fc unless noted):

| command | exit | summary |
|---|---|---|
| `pnpm exec vitest run kit/setup/stateguard.test.mjs kit/setup/layout.test.mjs kit/setup/staterepo.test.mjs kit/setup/lifecycle.test.mjs` | 0 | 4 files, 118 tests passed (at ea055dd; staterepo + lifecycle 40/40 at 81b72fc) |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm lint` | 0 | `eslint .` clean |
| `pnpm test` | 0 | 21 files, 945 tests passed |
| `pnpm build` | 0 | Compiled successfully (at ea055dd) |
| `pnpm test:e2e` | 0 | 16 passed (at ea055dd) |
| `loop-setup lint` | 0 | ok, 142 records |
| `loop-setup wiki-check` | 0 | ok, 9 pages |
| `loop-setup doctor` | 0 | 9 ok, 1 warn (workspace has 1 changed file before sync) |
| `loop-setup verify-kit` | 2 | waived (see Pre-flight) |
| `node kit/bin/loop-setup.mjs doctor` (the new code, on the live old-layout workspace) | 0 | `warn state repo outside the workspace — …/workspaces/loop-setup-e3ed255a/.git — it moves to …/state/loop-setup-e3ed255a.git at the next sync or restore`; nothing moved |
