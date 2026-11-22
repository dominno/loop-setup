# Playwright upgrade: E2E on the cloud image's Chromium, CI's e2e job back on ubuntu-latest (phase C)

Goal: pin `@playwright/test` to the version whose Chromium build matches the cloud image
(`/opt/pw-browsers`), so `pnpm test:e2e` runs there with no `PLAYWRIGHT_BROWSERS_PATH` shim. Move
CI's e2e job back to `ubuntu-latest` and drop its pin comment. Background:
`docs/plans/home-workspace/implementation-plan.md` ("Status fazy B", open items) and
`.claude/loop-workspace/topics/remote-env.md` (TR-1a2a7cac54bb, TR-e7829fbc9fc1).

Why (root cause): Playwright launches exactly the browser build its own `browsers.json` names.
The pinned 1.56.0 names Chromium 1194. This container's image ships `chromium-1243`,
`chromium_headless_shell-1243` and `ffmpeg-1011`, and only a scratchpad shim bridged the two.
The same pin also blocks CI: `ubuntu-latest` moved to 26.04, which 1.56.0 cannot install
Chromium on, so the e2e job was pinned to `ubuntu-24.04`.

Facts (read this session from each candidate's `playwright-core` `browsers.json`, from
`npm pack playwright-core@<v>`):

| playwright-core | chromium | chromium-headless-shell | ffmpeg |
|---|---|---|---|
| 1.56.0 (current pin) | 1194 (141.0.7390.37) | 1194 | 1011 |
| 1.62.0, 1.62.1 | 1234 | 1234 | 1011 |
| **1.63.0** | **1243 (153.0.8010.12)** | **1243** | **1011** |
| 1.64.0, 1.64.1 | 1248 | 1248 | 1013 |

- Only 1.63.0 matches the image. Its Chromium binary reports `Google Chrome for Testing
  153.0.8010.12`.
- 1.63.0 also lists `ubuntu26.04-x64` as an officially supported host platform, with its native
  dependencies (`lib/coreBundle.js`). So `playwright install --with-deps chromium` works on
  today's `ubuntu-latest`, and the runner pin can go.
- `@axe-core/playwright` (`^4.10.2`) takes `playwright-core` as a peer (`>= 1.0.0`). It needs no
  version change. Only its lockfile peer suffix moves.

Design: no product or kit code changes, so there is no core, port or adapter to change. The
decision is data: one exact version in `package.json`, and the lockfile regenerated with
`CI=true corepack pnpm@10 install` (the pnpm 10 vs 11 gotcha in `topics/remote-env.md`). The CI
job's `runs-on` goes back to `ubuntu-latest`, and the docs that name the Playwright version
(`README.md`, `kit/docs/adoption-guide.md`) follow it. KISS: no browser-matching script. A future
image bump is a version bump read off `browsers.json` again.

Tests first:
- `scripts/template-docs.test.mjs` already checks `verify.yml`'s jobs. It gains one test: the
  e2e job runs on `ubuntu-latest` and installs Chromium with its system deps, and
  `@playwright/test` is pinned to an exact version (a range would move the Chromium build
  without a deliberate bump). It fails before S03 (`runs-on: ubuntu-24.04`).
- Integration RED/GREEN: `pnpm test:e2e` with the image's own `PLAYWRIGHT_BROWSERS_PATH`
  (`/opt/pw-browsers`) and no shim fails on 1.56.0 (it wants the 1194 build) and passes on 1.63.0.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first: the e2e-job test in `template-docs.test.mjs` (RED), and the shim-less `pnpm test:e2e` run on 1.56.0 (RED) | scripts/template-docs.test.mjs | `pnpm exec vitest run scripts/template-docs.test.mjs` | — | done | 1fab58c |
| S02 | Pin `@playwright/test` to 1.63.0. Regenerate the lockfile with `CI=true corepack pnpm@10 install`. `pnpm install --frozen-lockfile` passes, and no other dependency moves. | package.json, pnpm-lock.yaml | `pnpm install --frozen-lockfile && pnpm test:e2e` | S01 | done | 1fab58c |
| S03 | CI's e2e job on `ubuntu-latest`, pin comment removed. The docs name Playwright 1.63. | .github/workflows/verify.yml, README.md, kit/docs/adoption-guide.md | `pnpm exec vitest run scripts/template-docs.test.mjs` | S02 | done | 1fab58c |
| S04 | Self-verify chain, the post-implementation critic round, and the wiki facts revised through `/dream` | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S03 | done | 1fab58c |

Pre-implementation critic round (tree 30cc9c917a8aba0e; single-pass reviewer, code-only):
`completion` accept. Nothing confirmed, deferred or revised, and no records. It was thin, though:
one reviewer, 3 tool calls, about 8 s. The post-implementation round is the real check.

RED → GREEN:
- `pnpm exec vitest run scripts/template-docs.test.mjs` exits 1 before S03 (the e2e job's
  `runs-on: ubuntu-24.04` fails the new test; the exact-pin check passes) and 0 after (30 passed).
- `pnpm test:e2e` uses the image's own `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, with no shim.
  On 1.56.0 it exits 1: 15 failed and 1 passed, each failure "Executable doesn't exist at
  /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell". On 1.63.0 it exits
  0 (16 passed).

Lockfile:
- `CI=true` turns on `--frozen-lockfile` in pnpm, so the plain `CI=true corepack pnpm@10 install`
  refuses a changed manifest (exit 1, "specifiers in the lockfile don't match"). The regeneration
  therefore ran as `CI=true corepack pnpm@10 install --no-frozen-lockfile` (pnpm 10.34.9).
- `pnpm install --frozen-lockfile` then passes on pnpm 10.28.0 (PATH) and 10.34.9 (corepack, as in
  CI).
- Package versions: only `@playwright/test`, `playwright` and `playwright-core` move, from 1.56.0
  to 1.63.0. `fsevents@2.3.2`, an optional dependency of `playwright` 1.56.0, drops out. This was
  checked by comparing the `name@version` sets of `packages:` and `snapshots:` before and after.
- The rest of the diff is peer-resolution suffixes:
  - `debug` no longer gets `supports-color@7.2.0` as its optional peer, so `(supports-color@7.2.0)`
    disappears from 95 snapshot keys. `supports-color@7.2.0` itself stays, as `chalk@4.1.2`'s
    dependency.
  - `@axe-core/playwright` and `next` change their `playwright-core`/`@playwright/test` peer
    suffix.
  - Regenerating from the unchanged 1.56.0 manifest leaves the lockfile untouched (95 suffixes).
    The churn therefore appears only once the bump makes pnpm re-resolve, not from the pnpm
    version alone.

Post-implementation critic round (tree 07f78239e0f99f54, HEAD 1fab58c; single-pass reviewer plus
the completeness critic, code-only):
- `completion` accept. Nothing confirmed, deferred or revised, no nice-to-haves, no reviewer failed,
  `notRechecked` empty, no records.
- The reviewers read the diff, the e2e job and the repo for leftover `1.56`/shim/`ubuntu-24`
  mentions. The completeness critic re-ran the `packages:` name@version diff of the lockfile
  between `main` and HEAD.

Wiki (`/dream`, `topics/remote-env.md`): TR-ec03808b5b04 revises TR-1a2a7cac54bb (the pin), and
TR-1ff807be9596 revises TR-e7829fbc9fc1 (the 2026-11-22 observation and the fallback shim). Both are
`COMMIT_QUALIFIED`.

## Remaining risks

- The fit to the image is exact: the next image Chromium bump breaks shim-less E2E here again,
  until the pin follows it (read the new build off `browsers.json`).
- CI downloads its own Chromium (`playwright install --with-deps chromium`), so CI does not catch
  an image mismatch, and the image does not catch a CI install problem. Whether 1.63.0 installs on
  `ubuntu-latest` is read from its platform table here, and is proven only by the first CI run.
- The lockfile's optional-peer churn (`debug` without `supports-color`) can change only how `debug`
  colours its output under `DEBUG=…`. No package version moved.
- The wiki's pnpm gotcha (`topics/remote-env.md`) says to regenerate with
  `CI=true corepack pnpm@10 install`. That needs `--no-frozen-lockfile` once the manifest changes.
