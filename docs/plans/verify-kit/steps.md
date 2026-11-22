# verify-kit — anchor kit integrity to a protected commit on the kit's remote (phase B)

Goal: `loop-setup verify-kit` reproduces the installed kit from `git show <commit>:kit/…` (rendering
`{{KIT}}` through the installer's own code), where `<commit>` (installed.json `source.commit`) must be
an ancestor of the kit remote's `refs/heads/main` or a `refs/tags/kit-v*` tag, fetched live into a
fresh temporary bare repository. It checks every installed kit file, the shim, every registered
`~/.claude/commands` file and every owned `settings.json` entry, and cross-checks installed.json against
the reproduction (never trusting it alone). `denylist-check` and `plan-items` run it as a gate:
`--level L2|L3` (and an undeclared level) refuse on a failure, `--level L1` only warns; an
unreachable remote fails closed.

Design approved in the session; pre-implementation critic round: TR-5f8cec37a385 (revise: node path
and stop-gate are not anchored — expected node = `process.execPath`, stop gate documented as
unanchored), TR-63dca6bb69d1 (qualify: `disableAllHooks` silently disables the owned hooks — a
failure; settings extras are out of scope), TR-cca8b27e0ce1 (qualify: record the kit prefix; a prefix
other than `kit` or a directory install cannot be verified, exit 2), TR-90c5f02cec46 (qualify, minor:
a loopback git-proxy URL can go stale — held, listed as a remaining risk).

Layers: **core** = `kit/setup/kittree.mjs` (install contract) and `kit/setup/integrity.mjs` (decisions);
**driven adapters** = `kit/setup/kitremote.mjs` (the remote, in a temporary repository) and
`kit/setup/verifykit.mjs` (installed files and settings, and the use case); **driving adapters** =
`loop-setup verify-kit`, `denylist-check`, `plan-items`.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Install contract in a pure core module, shared by install and verify-kit; install records `source.remote` (password stripped) and `source.prefix` | kit/setup/kittree.mjs, kit/setup/install.mjs, kit/setup/kitfiles.mjs, kit/setup/integrity.test.mjs | `pnpm exec vitest run kit/setup/integrity.test.mjs kit/setup/lifecycle.test.mjs` | — | done | 84f6395 |
| S02 | verify-kit core: expected install, comparison, protected-ref verdict, `disableAllHooks`, gate and level parsing | kit/setup/integrity.mjs, kit/setup/integrity.test.mjs | `pnpm exec vitest run kit/setup/integrity.test.mjs` | S01 | done | 84f6395 |
| S03 | Adapters and the `verify-kit` command: the remote in a fresh temporary bare repo (hardened git env, insteadOf refusal, timeouts), the installed state, exit 0/1/2 | kit/setup/kitremote.mjs, kit/setup/verifykit.mjs, kit/setup/commands.mjs, kit/bin/loop-setup.mjs, kit/setup/verifykit.test.mjs | `pnpm exec vitest run kit/setup/verifykit.test.mjs` | S02 | done | 84f6395 |
| S04 | Gates: `--level` on `denylist-check` and `plan-items` (L2/L3/undeclared refuse, L1 warns) for an installed kit; the lifecycle fixture gets a bare origin | kit/trace/cli.mjs, kit/setup/verifykit.test.mjs, kit/setup/lifecycle.test.mjs | `pnpm exec vitest run kit/setup` | S03 | done | 84f6395 |
| S05 | Docs: loop.md step 10 passes `--level`; command help and usage; README and planning guide; remaining risks | kit/loop.md, kit/trace/cli.mjs, kit/setup/commands.mjs, README.md, kit/docs/planning-guide.md, docs/plans/verify-kit/steps.md | `pnpm test` | S04 | done | 84f6395 |
| S06 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S05 | in-progress |  |

## Remaining risks (by design)

- The check is run by the installed code and by the node runtime its shim names; neither is anchored
  to the commit, so a tampered verifier or runtime can lie. verify-kit is drift detection; the real
  protection stays the Edit-deny rules and the sandbox (analysis §5.11).
- The remote's identity comes from installed.json: re-pointing `source.remote` and `source.commit` at
  a repository someone else controls is not caught. That needs a human-held anchor (phase B `anchors/`).
- A rollback to an older protected commit passes (any ancestor of main or a kit-v* tag is accepted).
- Global git config is honoured (the cloud proxy and credentials live there); a `url.*.insteadOf`
  that rewrites the remote to another repository is refused.
- Whether the opt-in stop gate is installed is read from installed.json and settings.json (it is
  advisory and always exits 0); extra hooks, extra allow rules and project/local settings scopes are
  not examined, except that `disableAllHooks` anywhere it applies fails the check.
- A remote recorded as a loopback git-proxy URL (`http://…@127.0.0.1:<port>/git/…`) fails closed once
  that endpoint is gone (TR-90c5f02cec46); the documented cloud flow reinstalls in every container.
- Every check fetches the protected refs afresh (about 1.4 s for this repository); there is no cache.
