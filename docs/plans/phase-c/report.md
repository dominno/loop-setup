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

Commits: ea055dd (S01–S05), 81b72fc (S03.1: `core.autocrlf=false`), 7f9ba0a (S06.1/S06.2: post-round fixes).

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

Critic rounds (code-only, single-pass reviewer; `priorRecords` = the brief minus records already
CLEARed, which can be neither open nor reused):

Pre-implementation (tree bd8432437f21a69e, the design only): `completion` reject → every finding
taken into the design before code (details in `steps.md`).

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| security | blocker | accept (TR-73f53598baa2) | renaming the old git dir carries a planted `commondir`/`config.worktree`/alternates past a config-only guard | skeptic reproduced on git 2.43 | rebuild a fresh git dir; guard git dir entries → done, CLEARed |
| frontend-arch | important | accept (TR-713d6c46b885) | init/clone/first checkout contradict rule 1 | scratch clone: empty tree | bootstrap path guarded by the incoming-tree rule → done, CLEARed |
| regression | important | qualify (TR-6d66091dd044) | a failed init/restore leaves an orphan `state/<id>.git` that wedges restore | reproduced ENOTEMPTY | temp names renamed last; init refuses; orphan moved aside → done, CLEARed |
| regression | important | qualify, not live (TR-09d6d62c3dc9) | rule 1 pinned to the current template refuses after a template edit; CRLF via autocrlf | template history | released-digest list, recovery text, `core.autocrlf=false` (81b72fc) → done, CLEARed |
| regression | blocker → important | revise (TR-e8de2cbc87d7) | the `existsSync(<ws>/.git)` gates are not named | scratch simulation | gates replaced, hook tests added → HOLD (CLEAR is not allowed on a revise); re-adjudicated below |

Post-implementation (tree 8072ee5bd85748a2, HEAD 81b72fc): `completion` accept, no reviewer
failed, `notRechecked` = TR-67a4bf436ad6, TR-ba38c0ce4290 (2026-10-31 completeness-lens records,
unrelated; the completeness critic was off).

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| security | important | qualify (TR-972c44ec1b85) | `.gitattributes`/`.gitmodules` matched case-sensitively; a nested or modules case variant passes on APFS/NTFS | code + case-folding LD_PRELOAD shim (not a real volume) | compare lowercased → fixed in 7f9ba0a (S06.1), RED then GREEN |
| security | important | qualify (TR-18b8caf62785) | migration carried the old config's `remote.origin.url` into the trusted git dir | reproduced: pull/push followed it | take the project's origin; `remote add --` → fixed in 7f9ba0a (S06.2), RED then GREEN |
| regression | important | reject (TR-c2e1780acd08) | SessionStart no longer swallows non-refusal errors | refuted by code and a run | none |

Nice-to-have, left as a risk: before migration, the hooks and doctor run `git status` in the old
`<ws>/.git` behind a check-then-use guard.

Re-check round (tree 2aa733bcad5b9159, HEAD 7f9ba0a; a separate checker): `completion` accept, no
findings, `notRechecked` empty. TR-972c44ec1b85 and TR-18b8caf62785 CLEARed. TR-e8de2cbc87d7 (a
revise, which CLEAR does not allow) was re-adjudicated by this round against the code, not
re-raised, and is HELD with that note. Full chain at 7f9ba0a: typecheck 0, lint 0, test 0 (946/946),
build 0, test:e2e 0 (16/16); `loop-setup lint` 0 (175 records), `wiki-check` 0, `doctor` 0.

Remaining risks: listed in `docs/plans/state-gitdir/steps.md` (the pre-migration status race, an
unserialized concurrent migration, the per-call guard cost, no real APFS/NTFS run, the live kit still
2dd64dd).

**C3 status: done** (green checkpoint: tests and chain pass, the last round accepts with no open
blocker, records written, sync done, commits pushed).

## C4 — a tamper-evident record store (per-writer hash chains, anchors outside the workspace)

Design and steps: `docs/plans/record-chain/steps.md` (approved by the user at the checkpoint, then
revised with the pre-implementation round's findings before any code).

Pre-flight: `loop-setup doctor` exit 0 (no fail).

Commits: 00587ca (the approved design), 180a3d5 (S01–S05), 6269bf0 (S03.1: hooks anchor; a
sandboxed writer is best-effort), c03a9da (S06.1/S06.2: post-round fixes), 70eb16c (S06.3: re-check fix).

Success criteria and evidence:
1. **Schema 1.1, additive.** 1.0 lines replay unchanged (the live store: 184 lines, all 1.0, the new
   lint ok with 0 errors and 0 warnings). A 1.1 line carries `chain {w, prev}` and
   `provenance.workspace`, filled by the writer only (a draft carrying either is refused); `w` is
   random per workspace and machine in `~/.claude/loop-setup/anchors/<id>.writer`, outside the synced
   state. Every replay — so `loop-setup lint` — verifies every chain (`chain.test.mjs`, the
   chained-writer block of `lib.test.mjs`).
2. **Two clones on real git** (`chainrepo.test.mjs`): union merges (merged order asserted, with an
   older kit's 1.0 line on one side) and a real `git rebase` keep lint green on both homes; editing a
   middle line and deleting a middle line turn it red.
3. **Anchors.** SessionStart verifies, then appends checkpoints to `anchors/<id>.jsonl` (per writer
   `{w, n, sha}`, the legacy lines as an id set, because a merge reorders writers); the writer and the
   Stop hook anchor too. Deleting an anchored tail is reported by lint, doctor, SessionStart ("Record
   store integrity check FAILED … not re-anchored") and sync (pre-lint), and the anchors file is not
   appended to. A missing anchors file (with a writer id) and a corrupt anchors line are failures.
4. **Policy v4.** `kit/rules/trace-policy.md`: marker 4, the v4 sentence, a *Tamper evidence (policy
   v4)* bullet with the precise guarantee; the evidence and action tables are unchanged; the contract
   test pins version 4 and the page/schema agreement; every `<trace-evidence-gate>` copy and
   `<loop-verifier>` are untouched (their parity tests are green).

Commands (HEAD 6269bf0):

| command | exit | summary |
|---|---|---|
| `pnpm exec vitest run kit/trace kit/setup` | 0 | 19 files, 877 tests (before the Stop-hook test); `chainrepo.test.mjs` 10/10 after |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm lint` | 0 | `eslint .`, 0 warnings |
| `pnpm test` | 0 | 23 files, 980 tests |
| `pnpm build` | 0 | Compiled successfully |
| `pnpm test:e2e` | 0 | 16 passed |
| `loop-setup lint` | 0 | ok, 184 records |
| `loop-setup wiki-check` | 0 | ok |
| `loop-setup doctor` | 0 | 9 ok, 1 warn (1 changed file before sync) |
| `loop-setup verify-kit` | 2 | waived (see Pre-flight) |
| `node kit/bin/loop-setup.mjs lint` / `doctor` (the new code, read-only, live store) | 0 / 0 | ok, 0 errors, 0 warnings / `ok record store chain and anchors — 0 checkpoint(s) anchored` |

Pre-implementation round (tree e99b66087f42e547): the first run could not be recorded (the writer
refused one draft for a bench ground-truth token, so nothing from it was acted on); the second run's
nine records were all taken into the design (`steps.md`, *Revisions*).

Pre-implementation (second run, tree e99b66087f42e547): `completion` defer (one blocker revised) →
every finding taken into the design before code (`steps.md`, *Revisions*).

| Critic | Severity | Verdict | Finding | Recommended action → done |
|---|---|---|---|---|
| frontend-arch | important | qualify (TR-9b325336d7bf) | the writer was wired at 3 of 5 CLI write sites; rotation not covered | one `chainedWrite` for all five, rotate under the lock → CLEARed |
| qa-e2e | important | qualify (TR-5a812bfd5cbe) | the planned tests missed the deciding cases | merged order with a 1.0 writer, rebase, lock, no-op, REUSE … → CLEARed |
| security | important | qualify (TR-ea1382b09a25) | the rolling legacy checkpoint is not merge-stable | legacy checkpoint as an id set → CLEARed |
| security | important | accept (TR-fbcce4b1397a) | absent anchors silently disable the checks | missing-with-writer is an error, none is a warning, guarantee stated → re-checked below |
| security | important | revise (TR-2684185404a4) | anchors only at SessionStart leave a window | writer + Stop hook anchor too → HELD (revise) |
| security | important | qualify (TR-177f4ecd5b23) | lock scope and writer-id race unspecified | one lock over load→append→anchor, O_EXCL writer → CLEARed |
| regression | blocker → design gap | revise (TR-6d5893f4387f) | batch chaining breaks on a no-op action | chain after dedupe, to appended lines → HELD (revise) |
| regression | important | qualify (TR-4c861a3d01be) | chain in the id breaks same-batch REUSE dedupe | chain-free dedupe → CLEARed |
| regression | important | revise (TR-05e230f34069) | an older kit's late 1.0 line is unrepairable red | a warning, not an error → HELD (revise) |

Post-implementation (tree 8434d9952a1217b0, HEAD 6269bf0): `completion` accept, no reviewer
failed, `notRechecked` empty.

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| security | important | qualify (TR-eac079ab5043) | a CLI write re-created a deleted anchors file without verifying (unsandboxed writers) | reproduced on the real stack | anchor only into an existing file → fixed in c03a9da (S06.1), RED then GREEN |
| regression | important | accept (TR-cc11d9353dc3) | stale-lock takeover could rename away a live lock | code + reproduction | nonce, checked takeover, release only own → fixed in c03a9da (S06.2), RED then GREEN |

Nice-to-haves: stale-takeover tests (taken); sync holds the lock across fetch and push (left, a
risk).

Re-check round (tree 9eedc021ebe8e717, HEAD c03a9da): `completion` accept, `notRechecked` empty.
TR-eac079ab5043, TR-cc11d9353dc3, TR-fbcce4b1397a CLEARed; the restated claims of the three revise
records not re-raised (HELD with that note). One new confirmed important finding:

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| regression | important | accept (TR-9d0a9461d049) | after S06.1 a rejected first write left a writer id with no anchors file: a permanent false "anchors were deleted" | reproduced by command | a new writer id comes with its anchors file → fixed in 70eb16c (S06.3), RED then GREEN |

Second re-check round (tree 6649b11ed79417ac, HEAD 70eb16c; the third and last): `completion` accept,
no findings, `notRechecked` empty. TR-9d0a9461d049 CLEARed. Full chain at 70eb16c: typecheck 0,
lint 0 (0 warnings), test 0 (24 files, 986), build 0, test:e2e 0 (16); `loop-setup lint` 0 (187
records), `wiki-check` 0, `doctor` 0. No open critic-panel blocker in the store.

Remaining risks: listed in `docs/plans/record-chain/steps.md` (the machine-local guarantee, no owned
Edit-deny on anchors/, sandboxed writers unlocked, the takeover window, sync holding the lock across
push, rotation and clock order, the v4 upgrade rule, the live kit still 2dd64dd).

**C4 status: done** (green checkpoint: tests and chain pass, the last round accepts with no open
blocker, records written, sync done, commits pushed).

## C5 — a done node counts for readiness only once its change has landed in HEAD

Design and steps: `docs/plans/landed-nodes/steps.md` (approved by the user at the checkpoint with a
new `LAND` action, policy v4 → v5; then revised with the pre-implementation round's findings).

Pre-flight: `loop-setup doctor` exit 0 (no fail).

Commits: 90414f4 (S01–S04), be096e0 (S05.1–S05.4: the pre-round findings).

Success criteria and evidence:
1. **What CLEAR records.** `kit/loop.md` step 10: the CLEAR note carries `patch-id <git patch-id
   --stable < patch>` and, when the loop committed, `commit <sha>`; `loop-iteration.js` and its
   `<loop-verifier>` block are untouched (the Lead composes the note).
2. **The landed port.** `kit/trace/landed.mjs` (pure): landed when a human LAND names the node, its
   commit is an ancestor of HEAD, a non-merge commit in HEAD's history has its patch-id (covers merge,
   squash of exactly that change, cherry-pick), or a non-merge commit carries the trailer `Plan:
   <node>`; otherwise unknown (git errors included). `readyIds`, `planItems`, `planViolations` take the
   port; only landed satisfies `after`; `plan-lint` warns `[done-unlanded]`; a human `LAND` overrides
   (refused under CLAUDECODE, for another consumer, without `--ref`, on a non-latest record). The git
   adapter is in `kit/trace/cli.mjs`.
3. **Real git** (`landedrepo.test.mjs`, 10 scenarios): merge, squash and cherry-pick count as landed;
   an unmerged branch does not (dependent not ready, `plan-items` refuses, `plan-lint` warns); a later
   change next to the hunk keeps it landed while `git apply --reverse --check` fails. Also: a
   diverged-context cherry-pick is unknown (fail safe) until a trailer lands it; a body-quoted or merge
   trailer does not land; no history scan when nothing waits.
4. **Legacy.** A done node whose (unchained, pre-change) CLEAR has no patch-id or commit counts as
   landed with `[done-legacy]`; a chained CLEAR that lost its tokens is unknown, never legacy.

Commands (HEAD be096e0):

| command | exit | summary |
|---|---|---|
| `pnpm exec vitest run kit/trace/landed.test.mjs kit/trace/landedrepo.test.mjs` | 0 | 2 files, 24 tests |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm lint` | 0 | `eslint .`, 0 warnings |
| `pnpm test` | 0 | 26 files, 1012 tests |
| `pnpm build` | 0 | Compiled successfully |
| `pnpm test:e2e` | 0 | 16 passed (no UI in scope: no evidence for this change) |
| `loop-setup verify-kit` | 2 | waived (see Pre-flight) |

Pre-implementation round (tree 761352ceda8dea66): `completion` accept; 2 confirmed important
(qualify) and 5 revised findings, all taken (S05.1–S05.4; `steps.md`, *Revisions*); TR-8072f9693313
refuted (note tokens are hex-validated before reaching git).

Post-implementation round (tree ea9995535bfc027b, HEAD be096e0): `completion` accept, no findings, no
reviewer failed, `notRechecked` empty. Note: in its trimmed `priorRecords`, the `reason` text of
TR-e29906271d8a was passed garbled (context only; the id, verdict and qualifier were right).

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| — | — | — | (none) | — | — |

Pre-round records closed: TR-850ed8145e0c and TR-e29906271d8a CLEARed; TR-7ffb007e267b,
TR-18939e8b164b, TR-b05e792136bc, TR-85e0b21a9ddf, TR-29fcbda2e618 (revise) HELD with their
resolution. No open critic-panel blocker in the store.

Remaining risks: listed in `docs/plans/landed-nodes/steps.md`.

**C5 status: done** (green checkpoint: tests and chain pass, the round accepts with no open blocker,
records written, sync done, commits pushed).

## C6 — the docs at the installed-kit model (infographics, Path A from the template)

Steps: `docs/plans/docs-refresh/steps.md`. Docs only: no kit behaviour change.

Pre-flight: `loop-setup doctor` exit 0 (no fail).

Commits: da592aa, 4ac72c6 (S04.1: a post-round nice-to-have).

Success criteria and evidence:
1. **Infographics.** The five `docs/infographic-*.svg` show install/init/sync/restore, the kit in
   `~/.claude` and the workspace on `claude/loop-state`, `loop-setup` commands; no `pnpm trace`, no
   "copy". Counts match `kit/commands` (14) and `kit/workflows` (7). PNGs regenerated from the SVGs
   with Playwright at `deviceScaleFactor: 2` (2736×1536), checked by eye.
2. **The doc test** (`scripts/template-docs.test.mjs`) is green and fails if an SVG says `pnpm trace`,
   "copy" or `.claude/memory` (RED on the old SVGs).
3. **Path A** (`kit/docs/adoption-guide.md`) covers a repo created from the template both ways with
   exact commands (remove `kit/` plus its test include, dev script, doc test and kit-only CI job, then
   install from upstream; or keep `kit/` and install from `.`); option 1 was run in a scratch clone
   (install, typecheck, lint, test, build all exit 0). The README quickstart links Path A.
4. **Every `loop-setup` subcommand** in the CLI help (35) appears in the adoption or planning guide
   (a doc test; 13 were missing, now in a *Command reference*).

Commands (HEAD da592aa):

| command | exit | summary |
|---|---|---|
| `pnpm exec vitest run scripts/template-docs.test.mjs` | 0 | 33 tests |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm lint` | 0 | `eslint .`, 0 warnings |
| `pnpm test` | 0 | 26 files, 1015 tests |
| `pnpm build` | 0 | Compiled successfully |
| `pnpm test:e2e` | 0 | 16 passed |
| `loop-setup verify-kit` | 2 | waived (see Pre-flight) |

Post-implementation round (tree 4e0ffa36d3966212, HEAD da592aa): `completion` accept, no finding
confirmed, deferred or revised, no reviewer failed, `notRechecked` empty; no records.

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| — | — | — | (none confirmed) | — | — |

Nice-to-haves: Option 1's kit leftovers (taken, 4ac72c6); the Path A test checks text, not the `sed`
run (left); infographic 4's footer names the kit repo's guide path (left). Full chain at 4ac72c6:
typecheck 0, lint 0, test 0 (26 files, 1015), build 0, test:e2e 0 (16).

Remaining risks: listed in `docs/plans/docs-refresh/steps.md`.

**C6 status: done** (green checkpoint: tests and chain pass, the round accepts with no open blocker,
no records to write, sync done, commits pushed).

## C7 — phase C closed: its status recorded, the closing rounds, the PR

Pre-flight: `loop-setup doctor` exit 0 (no fail).

Commits: ffbe2ac ("Status fazy C"), 74a9b73 (the closing round's fix), and this report section.

Success criteria and evidence:
1. **Status fazy C.** `docs/plans/home-workspace/implementation-plan.md` has a Polish "Status fazy C"
   section like phase B's: the goals that landed with their commits, the evidence, and what stays open.
   The C7 row and the closing rounds were added after the fix.
2. **Closing critic rounds** (code-only, completeness critic on, `git diff main...HEAD`). Three rounds
   ran, each reviewed by agents separate from the Lead:
   - Round 1 (tree 85e6004a93ea3ee7, HEAD ffbe2ac): `completion` accept, no findings, `notRechecked`
     empty. The journal showed the all-lens reviewer ran 4 shell commands and the completeness critic 3,
     over 50 files and about 4,400 lines. The Lead's `priorEvidence` had said the per-goal rounds already
     accepted, which invites confirmation. So the Lead did not rely on this round. No records.
   - Round 2 (same tree; neutral evidence, the seams between goals named): `completion` accept, with
     one confirmed important finding, TR-d3aba003bc20 (accept, regression):
     - `sync` held the store lock across the fetch (capped at 120 s), the push (300 s) and the fetch
       after it, while a writer waits 10 s for the lock.
     - The skeptic reproduced it with a slow pre-receive hook: a concurrent `loop-setup write` exited 1
       after 10.09 s, and the record was not stored.
     - It came in with C4 (180a3d5).
     - Also one nice-to-have: a repeated CLEAR (A, B, A) is deduped against the older A, so the latest
       CLEAR read for landing is B. Left, under risks.
   - Fix 74a9b73 (test first):
     - `pull` is split into `fetchState` (network) and `mergeFetched` (local).
     - `sync` holds the lock for the migration, and for lint, commit, merge and lint; it fetches before
       those steps and pushes after them.
     - `restore` of a workspace that is already here fetches outside the lock and merges inside it.
     - RED: probes in the remote's pre-receive hook and in `uploadpack.packObjectsHook` saw
       `fetch held` and `push held` for sync, and `fetch held` for restore. GREEN: `free`.
   - Round 3, the re-check (tree 958b9a15cc97c30b, HEAD 74a9b73; a separate checker): `completion`
     accept, nothing confirmed, deferred or revised, `notRechecked` empty, TR-d3aba003bc20 not
     re-raised. Two nice-to-haves, both left (scope control) and listed under risks:
     - the tests do not cover the post-push fetch, a write between the two lock sections, or a refusal
       inside a lock section;
     - the post-push `update-ref` now runs outside the lock and re-reads `HEAD`. A second sync on the
       same machine that commits in that window can have its unpushed commit recorded as pushed.
   - TR-d3aba003bc20 CLEARed (TA-f457e11003fe, ref 74a9b73). No critic-panel blocker is open. The latest
     blocker records are TR-73f53598baa2 (CLEARed), and TR-e8de2cbc87d7 and TR-6d5893f4387f (revise,
     re-adjudicated and HELD).
3. **Full chain, sync, PR.** The chain is green at 74a9b73 (table below), `loop-setup sync` is done,
   and the PR to `main` is open (link in the final report); not merged.

Commands (HEAD 74a9b73):

| command | exit | summary |
|---|---|---|
| `pnpm exec vitest run kit/setup/chainrepo.test.mjs` | 0 | 14 passed (2 new; both failed before 74a9b73) |
| `pnpm exec vitest run kit/setup/staterepo.test.mjs kit/setup/lifecycle.test.mjs kit/setup/anchors.test.mjs` | 0 | 44 passed |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm lint` | 0 | `eslint .` |
| `pnpm test` | 0 | 26 files, 1017 passed |
| `pnpm build` | 0 | first-load client JS 143.2 KB gzip (budget 155 KB) |
| `pnpm test:e2e` | 0 | 16 passed |
| `loop-setup lint` / `wiki-check` / `doctor` | 0 / 0 / 0 fail | 196 records, 0 errors, 0 warnings |
| `loop-setup verify-kit` | 2 | waived (see Pre-flight) |

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| regression (round 2) | important | accept (TR-d3aba003bc20) | `sync` held the store lock across fetch and push; a writer gives up after 10 s | workspace.mjs:520, anchors.mjs:94; skeptic repro: write exit 1 after 10.09 s, record not stored | fixed in 74a9b73; re-checked by round 3; CLEARed |
| regression (round 2) | nice-to-have | — | a repeated CLEAR (A, B, A) is deduped, so landing reads B | lib.mjs dedupe, landed.mjs `.pop()` | left (risk) |
| qa-e2e (round 3) | nice-to-have | — | lock tests skip the post-push fetch, interleaving and refusals | chainrepo.test.mjs | left (risk) |
| regression (round 3) | nice-to-have | — | post-push `update-ref` re-reads HEAD outside the lock | workspace.mjs:546-548 | left (risk); fix: push and update-ref an explicit SHA |

Remaining risks (in addition to C3–C6's):
- After 74a9b73, two concurrent syncs on one machine can record an unpushed HEAD as pushed (the
  post-push `update-ref` reads HEAD outside the lock). Then `syncStatus` says synced if the second
  push fails. Follow-up: read the SHA before the push and push and update-ref that SHA.
- The lock tests do not cover a write between sync's two lock sections or a refusal inside one.
- A CLEAR repeated with an earlier note (A, B, A) is deduped, so landing reads B's tokens.

**C7 status: done** (green checkpoint: tests and chain pass, the closing rounds accept with no open
blocker and `notRechecked` empty, the fix CLEARed, records written, sync done, commits pushed, PR open).
