# Loop denylist gaps: repo config files and symlink/gitlink modes (phase B)

Goal: the loop's hard denylist gate also escalates the repository's own configuration files —
the root `.gitignore`, `.gitattributes`, `.worktreeinclude` and `.mcp.json` — and any patch that
writes a symlink (`120000`), a gitlink (`160000`) or a file-mode change, in the workflow gate and in
`loop-setup denylist-check --patch` alike (analysis.md §8: "do denylisty dochodzą `.gitignore`,
`.gitattributes`, `.worktreeinclude` i `.mcp.json`; `denylist-check` eskaluje patche z trybem
`120000` (symlink) lub `160000` (gitlink)").

Why: `.gitignore`/`.gitattributes` change what git tracks, diffs and checks out (a hidden file, an
`export-ignore`, a merge or eol attribute) and `.worktreeinclude` what a fresh worktree copies;
`.mcp.json` adds MCP servers to every session in the project. A symlink can aim a later read or
write outside the tree or at a protected file through an open path (`src/x -> ../kit/loop.md`), a
gitlink pins code from outside the repo, and a mode change makes a file executable — none of these
shows up as a protected path.

Design (hexagonal): the decision is pure and lives in the shared `<loop-denylist>` block (the one
source of truth the workflows run, the CLI loads from the trusted copy and L3 pins by hash):
- `DENYLIST` gains `/^\.gitignore$/i, /^\.gitattributes$/i, /^\.worktreeinclude$/i, /^\.mcp\.json$/i`
  (root-anchored: src/ and e2e/ stay open).
- `diffModeHits(diff)` → the paths whose section writes a symlink, a gitlink or any other
  non-regular mode, or changes a mode. It reads the patch text line by line, hunks included: a
  header line can never pass as hunk content (every hunk line starts with ` `, `+`, `-` or `\`), so
  it sees every mode line git reads. Fail closed: a `new file mode` or `index … <mode>` counts as
  regular only when it is exactly `100644` or `100755` (git also reads `0120000` and ` 120000` as a
  symlink); any `old mode`/`new mode` line is a mode change. `deleted file mode` is not a hit.
- The `diff --git` header regex is shared by `diffPathScan` and `diffModeHits` (`DIFF_GIT`).
Adapters/driving: the loop-iteration gate escalates `escalated-denylist` with a
`denylist:mode:<paths>` gate; trace-bench mirrors it in `denylistHit`; `denylist-check` loads
`diffModeHits` with `hitsDenylist` from the trusted copy (HEAD in the kit source repo, the verified
installed file otherwise), reads the patch text, and adds the mode hits to `hits` (exit 1), listing
them again under `modeHits`. A trusted copy without `diffModeHits` fails closed (exit 2).

This changes the `<loop-denylist>` block, so its sha256 changes: an L3 bench record no longer
matches (`l3-check` unmet, "the denylist changed after the bench") — L3 needs a re-bench
(`/bench-checkers`). The `<loop-verifier>` block stays byte-identical.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first: HIT/CLEAR lists gain the four root config files (and nested near-misses under src/ and e2e/ in CLEAR); mode-gate tests for the workflow, the bench mirror and the CLI, with a parity test over one corpus | kit/test/denylist-modes.mjs, kit/trace/workflows.test.mjs, kit/trace/cli.test.mjs, kit/trace/contracts.test.mjs | `pnpm exec vitest run kit/trace/workflows.test.mjs kit/trace/cli.test.mjs kit/trace/contracts.test.mjs` | — | pending | — |
| S02 | `<loop-denylist>` block: the four rules, `DIFF_GIT`, `diffModeHits`; byte-identical in both workflows | kit/workflows/loop-iteration.js, kit/workflows/trace-bench.js | same | S01 | pending | — |
| S03 | Gates: loop-iteration escalation (`denylist:mode:`), trace-bench `denylistHit`, `denylist-check` hits/modeHits; implementer prompt and loop docs name the new entries | kit/workflows/loop-iteration.js, kit/workflows/trace-bench.js, kit/trace/cli.mjs, kit/loop.md, kit/docs/workflow-graphs.md, kit/rules/trace-policy.md | same | S02 | pending | — |
| S04 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S03 | pending | — |
