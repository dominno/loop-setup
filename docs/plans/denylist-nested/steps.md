# Loop denylist: nested .gitignore/.gitattributes, pnpm-workspace.yaml, next.config.* (phase B follow-up)

Goal: the loop's hard denylist gate escalates a `.gitignore` or `.gitattributes` at any depth
(`(^|/)\.gitignore$`, `(^|/)\.gitattributes$`), plus the root-anchored `^pnpm-workspace\.yaml$` and
`^next\.config\.[^/]+$`. This applies in the workflow gate (`loop-iteration.js`), in its bench
mirror (`trace-bench.js`) and in `loop-setup denylist-check --patch` alike. A nested `.mcp.json`
stays open, and so does code under `src/` and `e2e/`. This closes TR-7ceffeec49a1, held after
the denylist-gaps goal (`docs/plans/denylist-gaps/steps.md`) as a human decision. The decision
is now made: any depth.

Why (root cause of the changed expectations): git honours a `.gitignore` and a `.gitattributes`
in every directory, for that directory's subtree.
- A nested `src/.gitignore` (`*` plus `!.gitignore`) hides files from:
  - `git status`;
  - later `git add -N .` / `git diff` captures;
  - `git ls-files --others --exclude-standard`, and with it the `tree-id` fingerprint
    (`kit/trace/cli.mjs`) and the stop-gate snapshot (`kit/hooks/stop-gate.mjs`);
  - human review.
  A file written there afterwards, or planted by a hand-applied patch, lands unseen.
- A nested `.gitattributes` changes how its subtree is diffed (`-diff` shows "Binary files
  differ"), merged and checked out (`eol=crlf`).
- TR-7ceffeec49a1 verified both in a scratch repo. The root-anchored rules let them through, and
  the CLEAR lists in `kit/trace/workflows.test.mjs` and `kit/trace/cli.test.mjs` locked that gap
  in. Those expectations were wrong for the threat the rules exist to stop. They move from CLEAR
  to HIT.

Other root files that run code in the verify chain:
- `pnpm-workspace.yaml` holds pnpm's workspace settings. Its `onlyBuiltDependencies` decides which
  dependencies may run install scripts at `pnpm install`, alongside `overrides` and
  `patchedDependencies`.
- `next.config.*` is Node code that `pnpm dev` and `pnpm build` (the build gate) run.
- Both are read at the root only, so their rules stay root-anchored.

`.worktreeinclude` and `.mcp.json` are also read at the root only and stay root-anchored, so a
nested `src/app/.mcp.json` stays CLEAR.

Design (hexagonal, KISS). The decision is pure data in the shared `<loop-denylist>` block (the
core): the one source of truth that both workflows run, that the CLI loads from the trusted copy,
and that L3 pins by hash.
- **Core:** `DENYLIST` swaps `/^\.gitignore$/i, /^\.gitattributes$/i` for the any-depth
  `/(^|\/)\.gitignore$/i, /(^|\/)\.gitattributes$/i`, which match the root file too, so the
  root-anchored rules would be redundant. It gains `/^pnpm-workspace\.yaml$/i` and
  `/^next\.config\.[^/]+$/i`. The block comment says why. The copy in `trace-bench.js` stays
  byte-identical. No new function and no port: `hitsDenylist` is unchanged.
- **Driving adapters:** no code change.
  - The `loop-iteration.js` gate and trace-bench's `denylistHit` call `hitsDenylist`.
  - `denylist-check` loads it from HEAD (kit source repo) or the verified installed file.
  - The implementer prompt in `loop-iteration.js` (outside both measured blocks) names the new
    entries.
- **Docs:** `kit/loop.md` and `kit/docs/workflow-graphs.md` name them too.
- **Unchanged:** the `<loop-verifier>` block stays byte-identical
  (sha256 `83f857eb5b42ea29e11095bafd800e5f36e6800b381aa84ad0dd6c0cb02155e5`, marker lines
  included).

Tests first:
- `kit/trace/workflows.test.mjs`. HIT gains the nested files (`src/.gitignore`,
  `e2e/.gitattributes`, a deeper `src/app/deep/.gitignore`), `pnpm-workspace.yaml` and
  `next.config.{mjs,ts,js}`. CLEAR loses the two nested files. It keeps `src/app/.mcp.json`,
  `e2e/.worktreeinclude` and the code paths, and gains near-misses:
  - `src/foo.gitignore`, `src/gitignore.ts`, `docs/.gitignore-notes.md`;
  - `src/next.config.ts`, `next.config/x.ts`, `packages/a/pnpm-workspace.yaml`.
  Both workflow copies and the gate run use these lists.
- `kit/trace/cli.test.mjs`. The hand-written nested test now expects the nested
  `.gitignore`/`.gitattributes` in `hits` (exit 1) and `src/app/.mcp.json` clear (exit 0). A new
  end-to-end test builds REAL patches with git in a throwaway repo, the way the implementer
  captures them (`git add -N .` then `git diff --src-prefix=a/ --dst-prefix=b/`), and runs
  `denylist-check --patch` on each:
  - expected in `hits` (exit 1): a new `src/.gitignore` (`*` + `!.gitignore`), a new
    `e2e/.gitattributes`, an edit to `pnpm-workspace.yaml` and `next.config.mjs`, a new
    `next.config.ts`;
  - expected clear (exit 0): `src/` and `e2e/` code, a nested `.mcp.json`.

Pre-implementation critic round (tree b634745d50154d65; single-pass reviewer, code-only):
- `completion` accept. Nothing confirmed, deferred or revised, and no reviewer failed.
- Two nice-to-haves, both taken because they serve this goal:
  - the real-patch test also renames and deletes a nested file (S01);
  - the stale comments and titles that said "a nested .gitignore stays open" are rewritten (the
    test header comment and the CLI test title in S01, the block comment in S02).
- No records: the round adjudicated no claim.
- Prior records passed: the 8 denylist-related ones of `loop-setup query --latest --writer
  critic-panel --brief`. The full 40 (46 KB) would have had to be copied into the call by hand.
  Verdict reuse cannot fire on a new tree in any case.

Observed while writing S01: the implementer's capture drops a tracked file's deletion (git 2.43).
`git add -N .` stages the removal (the index shows `D`), so the worktree-vs-index diff no longer
shows it, and a rename keeps only its new side. The real-patch rename and delete cases therefore
diff against HEAD (`git diff HEAD -M`), as a hand-made patch would. This is not a gate bypass:
what the patch does not carry is never applied. It does mean a loop item cannot delete or rename
a tracked file. That is a pre-existing limit of the implementer prompt, outside this goal (see
Remaining risks).

This changes the `<loop-denylist>` block, so its sha256 changes. The L3 bench record no longer
matches (`l3-check` unmet: "the denylist changed after the bench"), and L3 needs a re-bench
(`/bench-checkers`). This goal does not run one: that is the user's decision.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first. HIT/CLEAR lists: the nested `.gitignore`/`.gitattributes` move to HIT, `pnpm-workspace.yaml` and `next.config.*` join HIT, near-misses join CLEAR. CLI: the nested expectation changes, and a real-patch `denylist-check` test is added (add, edit, rename and delete of a nested file). Both fail before S02. | kit/trace/workflows.test.mjs, kit/trace/cli.test.mjs | `pnpm exec vitest run kit/trace/workflows.test.mjs kit/trace/cli.test.mjs` | — | done | — |
| S02 | `<loop-denylist>` block: any-depth `.gitignore`/`.gitattributes`, root `pnpm-workspace.yaml` and `next.config.*`, comment. Byte-identical in both workflows. The implementer prompt and the loop docs name the entries. | kit/workflows/loop-iteration.js, kit/workflows/trace-bench.js, kit/loop.md, kit/docs/workflow-graphs.md | same | S01 | done | — |
| S03 | Self-verify chain and the post-implementation critic round. CLEAR TR-7ceffeec49a1 citing the commit. | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S02 | planned | — |

RED → GREEN (`pnpm exec vitest run kit/trace/workflows.test.mjs kit/trace/cli.test.mjs`):
- Before S02, 5 tests failed for the old-rule reason. The nested files, `pnpm-workspace.yaml` and
  `next.config.*` passed the hit lists. The gate run sent them to the verifier. `denylist-check`
  answered exit 0 with `hits: []` on every hand-written and real patch.
- After S02, the three files (`contracts.test.mjs` included) pass 356 of 356.

Changed expectations: `src/.gitignore` and `e2e/.gitattributes` move from CLEAR to HIT in
`workflows.test.mjs`, and from exit 0 to exit 1 in the `cli.test.mjs` nested list. The old
expectation was wrong for the threat: git honours a nested `.gitignore`/`.gitattributes` for its
subtree (root cause above, TR-7ceffeec49a1). Nothing else changed. `src/app/.mcp.json` stays
CLEAR, and the root list gains `pnpm-workspace.yaml` and `next.config.mjs` (added, not changed).

## Remaining risks

- The denylist hash changes, so L3 is unmet until a re-bench (`/bench-checkers`).
- `loop-setup denylist-check` in this checkout reads the block from HEAD, so it answers with the new
  rules only once S02 is committed. The CLI tests copy the working tree into a throwaway repo and
  commit it there, so they see the new block at once.
- The implementer's capture (`git add -N .`, then `git diff`) drops a tracked file's deletion, and
  a rename keeps only its new side. A loop item cannot delete or rename a tracked file. This
  predates the goal and is out of its scope: a follow-up for the implementer prompt (for example
  `git diff HEAD`).
