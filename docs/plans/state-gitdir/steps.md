# State git directory outside the workspace, planted git config refused (phase C, goal C3)

Goal: move each workspace's git directory out of the workspace and refuse planted git config, so a
write into the workspace can never run code at sync time.
Background: `docs/plans/home-workspace/analysis.md` §5.10 and §8 (red-team row "GIT_DIR `.history`
w katalogu zapisu: podrzucone hooki, fsmonitor i filtr wykonują się"), and
`implementation-plan.md` ("Status fazy B": "dziennik poza workspace'em").

Why (root cause): the workspace `~/.claude/loop-setup/workspaces/<id>/` is a git repository whose
GIT_DIR is `<ws>/.git`, inside the directory every session may write (the per-project
`additionalDirectories` grant). `HARDEN` (`-c core.hooksPath=/dev/null -c core.fsmonitor= …`)
neutralizes hooks and fsmonitor, but not the rest of the repository's own config, nor the work
tree's attributes. Reproduced this session (scratchpad, real git 2.x):
- `.gitattributes` `* filter=evil` plus `filter.evil.clean = sh -c 'touch MARK; cat'` in the
  repository config: **`git status` already runs the filter** (MARK appears), and `git add -A`
  runs it again. `status` is what `syncStatus` runs, so the Stop hook, the SessionStart hook and
  `doctor` execute it, not only `sync`.
- Git looks up a user-defined merge driver before the built-in one of the same name, so
  `merge.union.driver = <cmd>` in the repository config runs `<cmd>` for the template's own
  `merge=union` files at the next merging `sync`. No work-tree change is needed.

## Design

### Layout (core, pure: `kit/setup/layout.mjs`)

| path | holds |
|---|---|
| `~/.claude/loop-setup/workspaces/<id>/` | the state files only (wiki, store, plan, run log, `workspace.json`, the template `.gitattributes`); **no `.git`** |
| `~/.claude/loop-setup/state/<id>.git` | the workspace's GIT_DIR (a normal, non-bare git dir: `core.bare=false`, no `core.worktree`; the work tree is always passed explicitly) |

- `stateRoot(claudeHome)`, `stateGitDir(claudeHome, id)`: one source of truth for the path.
- `stateRepoLocation({ outside, inside, id })` → `{ kind, gitDir }`, where `outside` is "the state
  git dir exists", `inside` is what `<ws>/.git` is (`none` | `dir` | `other`) and `id` the
  workspace id or null:

  | outside | inside | id | kind | meaning |
  |---|---|---|---|---|
  | yes | none | any | `outside` | migrated (new layout) |
  | no | dir | id | `inside` | legacy: migrates at the next sync or restore |
  | no | dir | null | `inside-fixed` | legacy with no id (a scratch copy via `LOOP_SETUP_WORKSPACE` outside the workspaces root): used in place, never migrated |
  | yes | dir/other | any | `conflict` | refused: two candidate git dirs |
  | no | other | any | `conflict` | refused: `<ws>/.git` is a file or symlink (a gitfile could point anywhere) |
  | no | none | any | `none` | no state repo (doctor: "re-create it with init or restore", as today) |

  `id` comes from the layout's `workspaceId`, or, in `env` mode, from the path when it is a
  workspace directly under this home's workspaces root (`isWorkspacePath`).

### Guard (core, pure: new `kit/setup/stateguard.mjs`)

`stateRepoRefusal(facts)` → `null` or `{ cause }`. `facts` = the work tree's attribute files
`[{ path, content }]`, its `.gitmodules` paths, the state repo's own config entries
`[[key, value]]` (as `git config --file <gitdir>/config -z --list` prints them: section and key
lowercased; `--file` never follows `include.*`), the git dir entries that exist out of a fixed list,
and the template's `.gitattributes`. Refused (first match, the cause names the path or key):
1. the root `.gitattributes` is absent, or its sha256 is not one of `TEMPLATE_ATTRIBUTES_SHA256`, the
   digests of every released `kit/templates/workspace/.gitattributes` (one today: unchanged since
   ec6d24b, and the live workspace matches it byte for byte). A test pins the current template's
   digest into that list, so a future template edit adds a digest and never refuses older workspaces;
2. any other `.gitattributes` in the work tree (attributes apply per directory);
3. any `.gitmodules`;
4. a git dir entry git would follow to more config, attributes or objects: `commondir`, `gitdir`,
   `config.worktree`, `info/attributes`, `objects/info/alternates`, `objects/info/http-alternates`,
   `worktrees/`, `modules/` (the kit writes none of them);
5. any config key **outside an allowlist** of what `git init`/`git clone`/`git remote add` write for
   the state repo: `core.repositoryformatversion`, `core.filemode`, `core.bare`,
   `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`,
   `extensions.objectformat`, `remote.origin.url`, `remote.origin.fetch`,
   `branch.claude/loop-state.remote`, `branch.claude/loop-state.merge`. It covers the spec's list
   (`filter.*`, `diff.*.textconv`, `merge.*.driver`, every `core.*` hook setting) and every other key
   that names a command (`diff.external`, `gpg.*`, `credential.*`, `include*`, `protocol.*`,
   `remote.*.uploadpack|receivepack`, `extensions.worktreeconfig`, …) without listing them.

`incomingTreeRefusal({ paths, rootAttributes })`: rules 1–3 over a commit's tree
(`git ls-tree -r --name-only` + `git cat-file blob <c>:.gitattributes`, both of which only read
objects). It runs on `FETCH_HEAD` before `sync`/`restore` merge it, and on the cloned branch before
`restore` checks it out, so a planted file pushed to `claude/loop-state` never reaches the work tree.
Recovery from a refused remote commit: revert it on `claude/loop-state` from a plain clone; from a
refused work tree: put the template's `.gitattributes` back (the cause says so).

### Adapter (`kit/setup/workspace.mjs`)

- `stateRepo({ claudeHome, workspace, workspaceId })`: gathers the location facts (the
  `existsSync(<ws>/.git)` gates in `boundWorkspace`, `sessionStart`, `stop` and `doctor` all become
  this one decision).
- `stateGit(repo, args)`: reads the guard facts (a walk of the work tree for `.gitattributes`/`.gitmodules`,
  `git config --file <gitdir>/config -z --list`, which reads a file and runs nothing, and `lstat` of
  the listed git dir entries), refuses with a `StateRepoRefused` error (`code: 2`, the cause) when the
  guard says so, else runs `git --git-dir=<gitdir> --work-tree=<ws> ${HARDEN} <args>` (cwd = the work
  tree). Every state git call on an existing repo goes through it; the guard runs before each call, so
  a merge that changed the tree is re-checked by the next one.
- **Bootstrap** (the only calls that skip the work-tree rules, because the work tree is empty or the
  git dir does not exist yet): `git init --separate-git-dir` and `git clone --no-checkout
  --separate-git-dir`, both into `state/.tmp-<rand>.git` with an empty or template stage, plus
  restore's first `checkout`, which runs only after `incomingTreeRefusal` passed on the cloned tree
  and the config/entry rules passed on the fresh git dir. Nothing is created under its final name until
  the last step: `rename(tmp git dir → state/<id>.git)` and `rename(stage → workspaces/<id>)`; any
  failure removes the temporary git dir and the stage.
- `init`: refuses when `state/<id>.git` already exists; template stage, bootstrap init, then
  `remote add`/`add`/`commit` through `stateGit` on the temporary pair, then the two renames.
- `restore` (new machine): bootstrap clone; `incomingTreeRefusal` on the cloned branch;
  `workspace.json` read with `git show` (no checkout). When `state/<id>.git` exists with no workspace
  (an orphan: the workspace directory was deleted), it is moved aside to
  `state/<id>.git.orphan-<rand>` (kept, named in the result), never reused and never deleted. Then
  checkout and the two renames.
- `migrate(repo)` (kind `inside` with an id, at the next `sync` or `restore` of an existing workspace):
  **rebuilds** a fresh git dir instead of moving the old one, because `<ws>/.git` sat in the writable
  workspace and may carry `commondir`, `config.worktree`, alternates or hooks. No git command runs in
  the old git dir: bootstrap `git init --separate-git-dir=state/.tmp-<rand>.git`, then copy as plain
  files (regular files only, never a symlink) `objects/` (minus `objects/info/`), `refs/`,
  `packed-refs` and `logs/`; write `HEAD` from the old one only when it is `ref: refs/heads/<name>`
  or a 40/64-hex id; carry `remote.origin.url` (read with `git config --file … --get`, which runs
  nothing); then, through `stateGit`, `read-tree HEAD` (a fresh index) and `fsck --connectivity-only`.
  When HEAD resolves to the same commit as the old one (read from the files), rename into
  `state/<id>.git`, then remove `<ws>/.git`. Any failure before the rename removes the temporary dir
  and leaves the old layout as it was. HEAD, every ref (remote-tracking refs included), the reflogs and
  every object are the same; only the index is rebuilt from HEAD (the work tree is untouched, so an
  uncommitted change stays uncommitted).
- `restore` (workspace already here) and `sync`: `migrate` first, then as today.
- `pull`: `fetch`, `incomingTreeRefusal(FETCH_HEAD)`, `merge`, as today otherwise.
- `syncStatus(repo)`: as today, through `stateGit`.
- `lintGate` runs the lint processes with `GIT_CEILING_DIRECTORIES=<realpath of the workspaces root>`.
  Before, a git call there found the state repo at `<ws>/.git`; now nothing above the workspace is
  discovered.

### Driving adapters

- `loop-setup sync|restore`: a refusal exits **2**, `loop-setup <cmd> refused: <cause>`.
- The location kind replaces `existsSync(<ws>/.git)` in `boundWorkspace` (workspace.mjs), `sessionStart`
  and `stop` (hooks.mjs) and `doctor` (commands.mjs): git runs only for `outside`, `inside` and
  `inside-fixed`; `conflict` and a guard refusal give the refusal line (SessionStart) or a block (Stop);
  `none` stays silent, as a missing `.git` does today.
- Hooks never run a refused repo. SessionStart: the context carries one line,
  `- State repo refused: <cause> — run \`loop-setup doctor\``, and no sync status. Stop: it blocks
  once (as it does for unsynced state) with the cause, because a workspace that cannot sync is lost
  with a cloud machine. Neither hook migrates (they stay read-only on state).
- `doctor` replaces "workspace is a git repository" with one check:
  - ok `state repo outside the workspace — ~/.claude/loop-setup/state/<id>.git`
  - warn `state repo inside the workspace (<ws>/.git) — it moves to ~/.claude/loop-setup/state/<id>.git at the next sync or restore`
  - fail `state repo refused — <cause>` (the sync checks after it are skipped: they would run git)
  - fail `state repo: two git dirs` / `<ws>/.git is not a directory` (conflict)
  - fail `no state repo — cannot sync, re-create it with init or restore` (as today)

### Migration, rollback

- Trigger: the next `loop-setup sync` or `loop-setup restore` of an existing workspace (the Stop hook
  asks for a sync, so a live workspace migrates at the end of its next session). Nothing migrates on a
  read (`doctor`, hooks, `where`, lint).
- Rollback: `mv ~/.claude/loop-setup/state/<id>.git ~/.claude/loop-setup/workspaces/<id>/.git` and
  reinstall the previous kit. The rebuilt git dir has the same HEAD, refs, reflogs and objects and no
  `core.worktree`, and the remote branch `claude/loop-state` is not touched by the migration (no
  commit), so the old kit works as before. The new kit would migrate it again at the next sync.
- A crash between the rename into `state/<id>.git` and the removal of `<ws>/.git` leaves both: the
  next call is refused as a conflict whose cause says which to remove (the new one has the same HEAD).
- An adopter whose root `.gitattributes` differs from the template (a legacy `.claude/memory` copied
  over it by `init --from-legacy`) is refused with the fix in the cause: restore the template's content.

### Unchanged for the user

sync, restore, syncStatus, the Stop hook and doctor keep their outputs for a clean workspace;
`kit/setup/lifecycle.test.mjs` stays green. Its one direct state-repo probe,
`git(ws, "rev-parse", "--abbrev-ref", "HEAD")`, now names the git dir (`--git-dir`): the state repo
is no longer at `<ws>/.git` by design. The assertion (HEAD is on `claude/loop-state`) is unchanged.

## Pre-implementation critic round (tree bd8432437f21a69e; single-pass reviewer, code-only)

`completion` reject: one confirmed blocker. All five findings are taken into the design above.

| record | severity | verdict | finding | taken as |
|---|---|---|---|---|
| TR-73f53598baa2 | blocker | accept | renaming the old git dir carries a planted `commondir`, `config.worktree` or alternates past a config-only guard | `migrate` rebuilds a fresh git dir from plain files; guard rule 4 (git dir entries); rule 5 becomes an allowlist |
| TR-713d6c46b885 | important | accept | init, clone and the first checkout contradict rule 1 (empty work tree) | the bootstrap path, guarded by `incomingTreeRefusal` and the config/entry rules |
| TR-6d66091dd044 | important | qualify | a failed init/restore leaves an orphan `state/<id>.git` that wedges a later restore | temporary names, renamed last; init refuses an existing one; restore moves an orphan aside |
| TR-09d6d62c3dc9 | important | qualify (not live today) | rule 1 pinned to the current template refuses clean workspaces after a template edit | `TEMPLATE_ATTRIBUTES_SHA256` (every released digest, pinned by a test) and a recovery path |
| TR-e8de2cbc87d7 | blocker → important | revise | the `existsSync(<ws>/.git)` gates in `boundWorkspace`, `sessionStart` and `stop` are not named | named in S03/S04; tests for a dirty new-layout and migrated workspace |

Nice-to-haves taken: the ceiling is a realpath; config is an allowlist (it closes `diff.external`,
`gpg.*` and any key not yet thought of); hooksPath/fsmonitor tests assert the refusal itself. Left:
the per-call guard cost (a workspace is tens of files; checking before every call is the simplest
strong rule) and concurrent migration by two processes (under Remaining risks).

## Tests first

- `kit/setup/stateguard.test.mjs` (pure): the template passes; each rule refuses with its cause.
- `kit/setup/layout.test.mjs`: `stateGitDir`, every row of the `stateRepoLocation` table.
- `kit/setup/staterepo.test.mjs` (real git, the `lifecycle.test.mjs` harness: bare remote, two
  homes, the CLI as a process):
  - init and restore: `<ws>/.git` absent, `state/<id>.git` on `claude/loop-state`, not under the grant;
  - migration: a workspace in the old layout (its git dir moved back into it) keeps the same HEAD and
    `git log` after `sync`, and after `restore`; the workspace then has no `.git`;
  - planted, one test each, with a payload that writes a marker file: root `.gitattributes` with a
    filter, a nested `.gitattributes`, `.gitmodules`, `info/attributes`, `filter.*`,
    `diff.*.textconv`, `merge.union.driver`, `core.hooksPath`, `core.fsmonitor`, `include.path`,
    `commondir`, `config.worktree` with `extensions.worktreeConfig`. `sync` exits 2 naming the cause,
    `doctor` fails with it, the Stop hook blocks with it, and the marker is absent; controls show the
    payloads fire under plain git;
  - an old-layout git dir planted with `commondir`, `config.worktree` and alternates migrates into a
    fresh git dir that has none of them, with the same HEAD and history, and no payload runs;
  - a clean workspace in the new layout and a migrated one: dirty with a remote, the Stop hook blocks
    and SessionStart reports the unsynced state, as before; `init` refuses an existing
    `state/<id>.git`; restore moves an orphan `state/<id>.git` aside and clones;
  - a planted `.gitattributes` pushed to `claude/loop-state` by another clone: `sync` refuses the
    merge (exit 2), the work tree is unchanged and no marker exists;
  - a conflict (both git dirs) is refused and nothing is moved.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first: the guard and location unit tests, the real-git state-repo tests (RED); the pre-round findings' cases | kit/setup/stateguard.test.mjs, kit/setup/layout.test.mjs, kit/setup/staterepo.test.mjs, kit/setup/lifecycle.test.mjs | `pnpm exec vitest run kit/setup/stateguard.test.mjs kit/setup/layout.test.mjs kit/setup/staterepo.test.mjs kit/setup/lifecycle.test.mjs` | — | done | — |
| S02 | Core: `stateRoot`, `stateGitDir`, `stateRepoLocation`; the guard (`stateRepoRefusal`, `incomingTreeRefusal`) | kit/setup/layout.mjs, kit/setup/stateguard.mjs | same | S01 | done | — |
| S03 | Adapter: `stateRepo`, `stateGit` (explicit dirs + guard), `migrate`, init/restore/pull/sync/syncStatus, `lintGate` ceiling | kit/setup/workspace.mjs | same | S02 | done | — |
| S04 | Driving adapters: exit 2 on refusal, hook lines, the doctor check | kit/setup/commands.mjs, kit/setup/hooks.mjs | same | S03 | done | — |
| S05 | Docs: where the state repo lives, the refusals and the migration (adoption guide; KIT.md needed no change) | kit/docs/adoption-guide.md | `pnpm exec vitest run scripts/template-docs.test.mjs` | S04 | done | — |
| S06 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S05 | planned | — |

RED → GREEN:
- Before S02, `pnpm exec vitest run kit/setup/stateguard.test.mjs kit/setup/layout.test.mjs
  kit/setup/staterepo.test.mjs kit/setup/lifecycle.test.mjs`: 19 tests failed and
  `stateguard.test.mjs` did not load (no module). The two "behaves as before" hook tests already
  passed on the old code, as they should: they pin unchanged behaviour.
- After S02–S04: 118 of 118. One test-only fix on the way: a case name used as a claim_id had a space
  (the writer refused it, exit 1); the test now slugs it.
- Full chain: one failure, the bench leak guard (`contracts.test.mjs`): a line I added to the new test
  contained a 16-character fixture marker. The line was rewritten (found by line number only, the
  marker never printed); no changed file carries a marker.
- Changed expectation (root cause stated): `lifecycle.test.mjs` probed the state repo with
  `git(ws, "rev-parse", …)`, which relied on `<ws>/.git`. The repo is now at `state/<id>.git` by
  design, so the probe names it with `--git-dir`; the assertion is unchanged.

Live evidence (this machine, read-only): the new `doctor` on the real workspace loop-setup-e3ed255a
(installed kit 2dd64dd, old layout) reports `warn state repo outside the workspace —
…/workspaces/loop-setup-e3ed255a/.git — it moves to …/state/loop-setup-e3ed255a.git at the next
sync or restore`, and moves nothing (the live kit is still the old one; the move happens at the first
sync with a kit that has this change).
