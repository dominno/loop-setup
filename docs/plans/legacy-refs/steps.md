# Legacy evidence refs: a file-level map from the kit move, and explicit split files (phase C)

Goal: `loop-setup reaudit` resolves every evidence path written before the kit left the project tree.
Background: `docs/plans/home-workspace/analysis.md` §5.10-5.11 and §8, and
`implementation-plan.md` ("Status fazy B": "pełna mapa starych referencji").

Why (root cause): `legacyTarget` mapped old paths with a hand-written prefix list. Three gaps follow.
- **Absolute refs.** A record written in `/home/user/loop-setup` that cites
  `/home/user/loop-setup/scripts/trace/lib.mjs` reaches `git diff <commit> -- <absolute path>`. In
  any other checkout (a clone, CI) that path lies outside the repository. git fails, and reaudit
  fails closed, so it reports "evidence changed" whatever the content.
- **Split files.** `.claude/memory/topics/trace.md` mapped to the workspace page alone, but at the
  move (ec6d24b) its policy half went to `kit/rules/trace-policy.md`. A record older than that
  compares against a page that lost half its text, so it reads as "changed" on every run,
  forever.
- **Prefix rules.** A file under a moved directory that the move did not carry over was mapped
  anyway.

Facts (read this session):
- The move commit ec6d24b has 46 renames from outside `kit/` into `kit/`
  (`git diff -M --name-status ec6d24b^ ec6d24b`). The PR #20 merge shows 61, but the extra 15
  are `.claude/memory/*` paired with the frozen copies in `kit/test/fixtures/legacy-v1/`. Those
  belong to the workspace, not the fixture, so they are not map entries.
- `.claude/commands/`, `.claude/hooks/`, `.claude/trace/`, `.claude/workflows/`, `scripts/hooks/` and
  `scripts/trace/` hold no file at ec6d24b: the move emptied them.
- Splits (the kit half added in the split commit, the other half stays):

  | source | split at | into |
  |---|---|---|
  | `CLAUDE.md` | 4ccf257 | project `CLAUDE.md` + `kit/rules/KIT.md` |
  | `.claude/memory/topics/trace.md` | ec6d24b | workspace `topics/trace.md` + `kit/rules/trace-policy.md` |
  | `.claude/memory/loop-plan.md` | 9654bfb | workspace `loop-plan.md` + `kit/templates/workspace/loop-plan.md` (its schema) |

- The legacy-v1 fixture store cites 44 distinct paths. 16 of its 22 provenance commits are no longer
  reachable (squash-merged away), and reaudit lists those records apart as `unreachable`.

Design (hexagonal):
- **Core (pure), `kit/setup/layout.mjs`.** Data: `LEGACY_REF_MAP` (the 46 renames, file-level),
  `LEGACY_PROJECT_ROOTS`, `LEGACY_VACATED_DIRS` and `LEGACY_SPLITS`. Functions:
  - `normalizeRefPath(path, roots)`: an absolute path under the project root or a legacy root
    becomes repo-relative.
  - `resolveLegacyRef(path, { roots })`: exactly one kind: `unchanged`, `moved`, `workspace`,
    `split` or `unmapped` (an absolute path outside every root, or a file under an emptied
    directory with no rename).
  - `evidenceHome(path, { roots, predates })`: what reaudit compares against. `{ split: at }` when
    the record predates the split, otherwise the current home, or `null` (unmapped: fail closed).
  - `legacyTarget` keeps its contract on top of these.
- **Core (pure), `kit/trace/lib.mjs`.**
  - `evidencePaths(record)`: the paths reaudit reads, shared with the golden test.
  - `reauditCandidates(…, actions)`: takes a `{ split: at }` answer from the injected `changedSince`.
    It reports such a path once, under `split` ("split at <commit> — re-verify"), until a REAUDIT
    action with `ref` `split:<at>:<path>` acknowledges it.
- **Adapter, `kit/trace/cli.mjs`.** `changedSince` does the git and fs work: `git merge-base
  --is-ancestor <commit> <at>^` for `predates` (an unreachable split commit counts as predating:
  re-verify), `git show` and a file read for a moved or workspace home, and `git diff --quiet` for
  an unchanged path. `reaudit --act` writes the split acknowledgements and `--annotate` prints them.
- **CI.** The tests that read git history (the map against the move commit, the full-history
  reaudit) need full history, so the `checks` job checks out with `fetch-depth: 0`. The provenance
  job already does.

Tests first:
- `kit/setup/layout.test.mjs`:
  - unit tests for `normalizeRefPath`, `resolveLegacyRef` (every kind) and `evidenceHome`;
  - the golden table of all 44 fixture paths, with zero `unmapped`;
  - history tests: the map equals the move commit's renames, the emptied directories are empty
    at the move, and each split commit adds the kit half.
- `kit/trace/lib.test.mjs`: a split answer is reported once and cleared by its REAUDIT action, and
  a changed path stays.
- `kit/trace/cli.test.mjs`: `reaudit` over the fixture store in a full-history clone of this repo.
  Every "changed" path really differs by content (an independent `git show`/read oracle), and the
  split `topics/trace.md` is reported as split at ec6d24b, not as changed. After `--act` it is gone.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first: layout unit and golden tests, history tests, the reauditCandidates split test, the full-history CLI test (RED) | kit/setup/layout.test.mjs, kit/trace/lib.test.mjs, kit/trace/cli.test.mjs | `pnpm exec vitest run kit/setup/layout.test.mjs kit/trace/lib.test.mjs kit/trace/cli.test.mjs` | — | done | f6e0023 |
| S02 | Core: the file-level map, roots, emptied directories, splits, `normalizeRefPath`, `resolveLegacyRef`, `evidenceHome`, `legacyTarget` on top; `evidencePaths` and the split-aware `reauditCandidates` | kit/setup/layout.mjs, kit/trace/lib.mjs | same | S01 | done | f6e0023 |
| S03 | Adapter: `changedSince` through `evidenceHome` (ancestry, content compare), `reaudit --act`/`--annotate` for splits; CI `fetch-depth: 0` for the checks job | kit/trace/cli.mjs, .github/workflows/verify.yml, kit/docs/adoption-guide.md | same | S02 | done | f6e0023 |
| S03.1 | Pre-round finding TR-f950ffeb431f: tri-state `predates` (unknown counts as older) in the core; exit-status adapter; a unit case and a CLI test without the split commit | kit/setup/layout.mjs, kit/trace/cli.mjs, kit/setup/layout.test.mjs, kit/trace/cli.test.mjs | `pnpm exec vitest run kit/trace/cli.test.mjs -t "split commit is not"` | S03 | done | f6e0023 |
| S04 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S03.1 | done | f6e0023 |
| S04.1 | Post-round nice-to-have: the reaudit consumers (`/dream` step 1c, `/sync-story-status` step 1) name the `split` result | kit/commands/dream.md, kit/commands/sync-story-status.md | `pnpm exec vitest run scripts/template-docs.test.mjs` | S04 | done | — |

Pre-implementation critic round (tree e3187bb721700905; single-pass reviewer, code-only):
- `completion` accept. One confirmed important finding, TR-f950ffeb431f (accept): the rule "an
  unreachable split commit counts as predating" had no test, and the `git()` helper returns null for
  any failure. It cannot tell `merge-base --is-ancestor` exit 1 (not an ancestor) from 128 (commit
  missing).
- Fixed (S03.1):
  - `predates` answers true, false or null (unknown).
  - The pure `evidenceHome` treats null as older (re-verify), with a unit case.
  - The adapter reads `merge-base`'s exit status with `spawnSync`: 0 → true, 1 → false, any
    other → null.
  - A CLI test runs reaudit in a throwaway repo without 4ccf257: CLAUDE.md is listed as split, and
    `--act` clears it.
- Nice-to-haves taken:
  - the map is compared after sorting;
  - a positive oracle: the absolute `/home/user/loop-setup/scripts/trace/lib.mjs` ref, whose content
    did change, is listed as changed;
  - `fetch-depth: 0` on the `test` leg only;
  - two residuals under Remaining risks.
- `splitAckRef` (lib.mjs) is the one place the ack ref is built, used by `--act` and the core.

RED → GREEN:
- Before S02, 8 new tests failed: the missing exports, and `reauditCandidates` counting a
  `{ split }` answer as changed.
- After S02/S03, `pnpm exec vitest run kit/setup/layout.test.mjs kit/trace/lib.test.mjs
  kit/trace/cli.test.mjs` passes 234 of 234.
- No existing expectation changed: `legacyTarget` keeps its contract on top of the file-level map.

`reaudit` over the fixture store in a full-history clone, with this code:
- 93 candidates: 20 changed (each one differs by content), 1 split (TR-cb3baca81e27,
  `/home/user/loop-setup/.claude/memory/topics/trace.md`, split at ec6d24b) and 73 unreachable.
- After `--act`: 0 split, and the same 20 changed.
- Before (old code): the same 20 changed, and the split file was among them, as changed.

Post-implementation critic round (tree 2fccd418c2881d5a, HEAD f6e0023; single-pass reviewer plus
the completeness critic, code-only):
- `completion` accept. Nothing confirmed, deferred or revised, no reviewer failed, `notRechecked`
  empty, no records.
- TR-f950ffeb431f was passed in and not re-raised. It is CLEARed (`multi-agent-dev`, ref f6e0023).
- Two nice-to-haves:
  - `kit/commands/dream.md` step 1c and `kit/commands/sync-story-status.md` did not mention the new
    `split` result. Each now does, in one sentence (S04.1).
  - `legacyTarget` has no production caller left. It is kept as a tested public export, because
    removing it would drop its tests. Its contract is unchanged.

## Remaining risks

- A record made on a branch that forked before a split and was never merged into the split's
  history is not an ancestor of `<split>^`. It is therefore compared with the post-split home and
  reads as changed. That fails closed (noisy, not silent).
- `LEGACY_PROJECT_ROOTS` names only `/home/user/loop-setup`, where every absolute ref in the frozen
  pre-move store was written. An absolute ref from any other checkout stays `unmapped` and counts as
  changed (fail closed).

- The map covers the kit move (ec6d24b) and the three splits. A later move needs its own entries.
  The history test pins only ec6d24b.
- The history tests need full git history: in a shallow clone they fail and say so.
