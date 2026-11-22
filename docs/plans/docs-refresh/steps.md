# Docs at the installed-kit model: the five infographics and Path A from the template (phase C, goal C6)

Goal: bring the docs up to the installed-kit model: redraw the five README infographics and document
starting a new project from the template. Docs only: no kit behaviour change.

Why (root cause): the infographics and Path A were written for the copy-the-template model (phase A):
`.claude/memory/`, `pnpm trace`, "what to copy into your repo", copy-based adoption steps. Since the
kit moved into `~/.claude` and the state onto `claude/loop-state`, they described a model the repo no
longer has, and nothing tested for it.

What changed:
- `docs/infographic-*.svg` (text only, the layout kept): `loop-setup` instead of `pnpm trace`;
  infographic 3 says what lives where (the contract and the story map in your repo, the kit in
  `~/.claude`, the workspace on `claude/loop-state`), the CLI box names install · init · sync ·
  restore, the memory index's catalog is injected at session start; infographic 4's six adoption
  steps are install, init, wire verify, merge settings, check (`doctor`, `verify-kit`), first
  session (ending with `loop-setup sync`), and `kit/` joins the denylist pills; infographic 5 names
  the workspace's plan and `loop-setup` plan commands, and readiness needs deps that landed (C5).
  Counts (14 commands, 7 workflows) were already right and stay pinned by the test.
- PNGs regenerated from the SVGs with Playwright (Chromium, `deviceScaleFactor: 2`, 2736×1536, the
  same size as before), checked by eye for overflow (three labels were shortened after the first
  render).
- `kit/docs/adoption-guide.md` Path A: a repo created from the template either removes `kit/` (with
  `scripts/template-docs.test.mjs`, the `loop-setup` dev script, the kit's vitest include, the
  `provenance` CI job and the history depth) and installs from upstream, or keeps `kit/` as its own
  kit source and installs from `.`; exact commands for both. A *Command reference* lists every
  `loop-setup` subcommand. The README quickstart links Path A.
- `scripts/template-docs.test.mjs`: the SVGs may not say `pnpm trace`, "copy" or `.claude/memory`
  and must show the installed-kit model; every `loop-setup` subcommand in the CLI help
  (`commands.mjs` USAGE + `loop-setup help`) appears in the adoption or planning guide; Path A carries
  both options' exact commands and the README links it.

RED → GREEN:
- The SVG test fails on the old SVGs (`git stash` of the five: `infographic-1 … not to match
  /\.claude\/memory/`) and passes on the new ones; the two guide tests failed before the guide
  changes (13 subcommands missing; no Path A options, no README link).
- After: `scripts/template-docs.test.mjs` 33/33; full `pnpm test` 26 files, 1015 tests.

Path A option 1, run for real in a scratch clone of this branch: `git rm -r -q kit
scripts/template-docs.test.mjs`, `npm pkg delete scripts.loop-setup`, the `sed` on `vitest.config.ts`
(include becomes `["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.mjs"]`), then
`pnpm install --frozen-lockfile` 0, `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 0 (2 files, 13
tests), `pnpm build` 0. (The CI edit is a manual job deletion; it was not run.)

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first: no `pnpm trace`/copy in the SVGs; every CLI subcommand documented; Path A both ways + README link (RED) | scripts/template-docs.test.mjs | `pnpm exec vitest run scripts/template-docs.test.mjs` | — | done | — |
| S02 | The five SVGs at the installed-kit model; PNGs regenerated (Playwright, DSF 2) | docs/infographic-*.svg, docs/infographic-*.png | same | S01 | done | — |
| S03 | Path A both options with exact commands; Command reference; README quickstart link | kit/docs/adoption-guide.md, README.md | same | S01 | done | — |
| S04 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S02, S03 | planned | — |
