# L3 requires the sandbox and pins both the `<loop-verifier>` and `<loop-denylist>` hashes (phase B)

Goal: a bench record names the `<loop-verifier>` block it measured and the `<loop-denylist>` block
that guarded it (`benchRecordDraft`, `loop-setup bench-score --record`), and `loop-setup l3-check`
is not met when either changed after the bench (a record without the denylist hash needs a re-bench).
L3 also requires the Claude Code sandbox: the effective settings switch it on and hold
`sandbox.allowUnsandboxedCommands: false` at user scope (or by managed policy). `loop-setup doctor`
reports the sandbox state. The checklist and the kit rules state that sandbox-off L2 has no local
tamper resistance.

Pre-implementation critic round (tree 65b331e4a7e95cda): TR-bb40873dca00 (qualify, hardening):
the settings reader must not read an unreadable or non-object settings file as absent. Done:
`readSettingsFile` returns null only for ENOENT; any other read error, or JSON that is not an object,
is `{ error }` (fail closed). TR-2e055785d661 (revise): a sandbox enabled from project or local
scope can be removed between sessions. Repair applied as the residual-risk option: the effective
value stays the rule (it matches Claude Code's merge, and `/sandbox` writes `settings.local.json`),
the checklist advises user scope, and it is listed below.

Layers: **core** = `kit/setup/sandbox.mjs` (`sandboxPosture`, `withSandbox`) and `kit/trace/lib.mjs`
(`denylistBlockHash`, `benchRecordDraft`, `l3Check`); **driven adapter** = `kit/setup/settings.mjs`
(`readSettingsFile`, `settingsSources`: managed drop-ins and `managed-settings.json`, the project's
local and shared settings, the user's), reused by `verifykit.mjs`; **driving adapters** =
`loop-setup l3-check`, `loop-setup bench-score --record`, `loop-setup doctor`.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Bench records pin the `<loop-denylist>` block too; `l3Check(state, { verifier, denylist })` is unmet when it changed or is missing (re-bench) | kit/trace/lib.mjs, kit/trace/cli.mjs, kit/trace/lib.test.mjs, kit/trace/cli.test.mjs | `pnpm exec vitest run kit/trace/lib.test.mjs kit/trace/cli.test.mjs` | — | done | d4832c1 |
| S02 | Sandbox posture: pure decision over the settings scopes, the settings adapter (fail closed), `l3-check` = bench AND sandbox, `doctor` reports it | kit/setup/sandbox.mjs, kit/setup/settings.mjs, kit/setup/verifykit.mjs, kit/setup/commands.mjs, kit/trace/cli.mjs, kit/setup/sandbox.test.mjs | `pnpm exec vitest run kit/setup/sandbox.test.mjs` | S01 | done | d4832c1 |
| S03 | Docs: the checklist's Sandbox item and both pinned blocks, the kit rules' statement, trace-policy, README, command help; doc and parity tests | kit/loop-checklist.md, kit/rules/KIT.md, kit/rules/trace-policy.md, README.md, scripts/template-docs.test.mjs | `pnpm exec vitest run scripts/template-docs.test.mjs` | S02 | done | d4832c1 |
| S04 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S03 | in-progress | |
| S04.1 | Post-implementation round TR-badc6d060f90 (accept): a managed `allowUnsandboxedCommands: true` over a user `false` was read as held — the first managed source that sets it now decides (managed outranks user), else a user `false` holds | kit/setup/sandbox.mjs, kit/setup/sandbox.test.mjs | `pnpm exec vitest run kit/setup/sandbox.test.mjs` | S04 | done | |

Existing tests changed their inputs only, no assertion: `lib.test.mjs` drafts and `l3Check` calls
carry the denylist hash; `cli.test.mjs` runs the CLI with a hermetic Claude config dir whose user
settings switch the sandbox on (it read the developer's own settings before), `benchDraft` carries
the denylist hash, and `tempRepo` copies the new modules. When neither block can be read (the
workflow file is gone), l3-check reports one combined "cannot be read" item: one cause, one line.

## Remaining risks

- The settings show intent, not runtime: a sandbox that is enabled but unavailable on the machine
  (no bubblewrap) can fall back unless `sandbox.failIfUnavailable` is set; l3-check does not check that.
- `--settings` files and server-managed or MDM policy are invisible to l3-check (a `--settings` file
  holding the fallback closed is not credited; fail closed).
- A sandbox enabled only in the project's or the local settings can be switched off by a repository
  or settings change between sessions (TR-2e055785d661); set it at user scope to hold it on.
- The record pins the working-tree blocks at `--record` time, not a hash taken when the bench ran.
- l3-check is a self-assessment run by the installed code; the sandbox, Edit-deny rules and
  `verify-kit` remain the protections.
