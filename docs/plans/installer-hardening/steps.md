# Installer hardening: refuse agent-driven lifecycle writes, fix the open critic nice-to-haves (phase B)

Goal: `loop-setup install` and `uninstall` refuse the session's own Claude home from inside Claude
Code (CLAUDECODE set), and the installer owns user-scope deny rules for those subcommands and for a
direct `node …loop-setup.mjs` run; a `settings.json` that is not a plain object is refused before
any change; hook command paths are shell-safe; `ensureLink` repairs only links into this home's
workspaces root. Phase A's critic nice-to-haves (implementation-plan.md "Status"): non-object
settings.json → partial install, unescaped hook command paths, `ensureLink` matching by regex.

Pre-implementation critic round (TR-c0063242b5a4, TR-492dec6bf464, TR-dbbc3113e2e7; its `treeId`
was passed as fcf5b35e8dbb5d5a by mistake — the tree it reviewed is 64207630acc37715, commit cdabdda):
- qualify — a settings.json that is an object with wrongly typed `hooks`/`permissions` made
  `mergeSettings` throw after the kit was written: the merge now runs before the first write
  (install) and before the first removal (uninstall), with a clear error.
- revise — the session-start hook's `export PATH="…"` line in CLAUDE_ENV_FILE is a shell sink too:
  it is built with `shellArg` now.
- revise — design wording: under CLAUDECODE the CLI always refuses (its target is the session's home);
  "a different home still works" is the in-process `install({ claudeHome, env })` case. No code change.

Layers: **core** = `kit/setup/guard.mjs` (`lifecycleRefusal`), `kit/setup/kittree.mjs` (`shellArg`,
owned deny rules), `kit/setup/layout.mjs` (`isWorkspacePath`, also used by `resolveLayout`);
**adapters** = `kit/setup/install.mjs` (resolves the homes, reads settings fail-closed through
`settings.mjs`, validates and merges before any write), `kit/setup/workspace.mjs` (`ensureLink`),
`kit/setup/hooks.mjs` (PATH line); **driving** = `loop-setup install|uninstall` (`commands.mjs`).

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | CLAUDECODE refusal for the session's own home (realpath, alias-proof) in `install()`/`uninstall()`; owned deny rules for install/uninstall (bare and `*/loop-setup` spellings) and `Bash(node *loop-setup.mjs*)` | kit/setup/guard.mjs, kit/setup/install.mjs, kit/setup/kittree.mjs, kit/setup/commands.mjs, kit/setup/hardening.test.mjs, kit/setup/integrity.test.mjs | `pnpm exec vitest run kit/setup/hardening.test.mjs` | — | done | b7e805e |
| S02 | A settings.json that is not a plain object, or whose hooks/permissions have the wrong shape, is refused before any change | kit/setup/install.mjs, kit/setup/settings.mjs, kit/setup/hardening.test.mjs | same | — | done | b7e805e |
| S03 | Shell-safe paths: `shellArg` quotes (double, or single when the path holds `"`) and rejects metacharacters; used by the hook commands, the shim and the CLAUDE_ENV_FILE PATH line; validated before any write | kit/setup/kittree.mjs, kit/setup/install.mjs, kit/setup/hooks.mjs, kit/setup/hardening.test.mjs | same | — | done | b7e805e |
| S04 | `ensureLink(projectRoot, ws, claudeHome)` repairs only a link whose target is directly under `workspacesRoot(claudeHome)` (`isWorkspacePath`) | kit/setup/layout.mjs, kit/setup/workspace.mjs, kit/setup/hooks.mjs, kit/setup/hardening.test.mjs | same | — | done | b7e805e |
| S05 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S01–S04 | in-progress | |
| S05.1 | Post-implementation round TR-6acaf502b2c6 (qualify): array-valued `hooks`/`permissions` passed the implicit shape check (an array is truthy; JSON drops the merged entries) — explicit pure `settingsShapeProblem` before the merge | kit/setup/kittree.mjs, kit/setup/install.mjs, kit/setup/hardening.test.mjs | `pnpm exec vitest run kit/setup/hardening.test.mjs` | S05 | done | |

Tests first: every new test in `kit/setup/hardening.test.mjs` failed against the old behaviour
(temporary stubs with today's semantics: 15 failed, 1 — "a different home still works" — passed, as
it must before and after; then 5 more for the critic round's two fixes). Existing tests: one
expectation changed — `integrity.test.mjs` pins `ownedSettings().deny` exactly, and the deny list
gains the lifecycle rules (root cause: criterion 1 adds owned rules; still an exact assertion).
`cli.test.mjs`'s `tempRepo` copies `guard.mjs` (the CLI's module closure grew). No other change.

## Remaining risks

- A wrapper that clears CLAUDECODE (`env -u CLAUDECODE loop-setup install …`) passes both the refusal
  and the `*/loop-setup install` deny spellings (round-1 nice-to-have, not acted on): the guard is for
  an agent following instructions; the sandbox is the boundary.

- The refusal and the deny rules are policy guards for an agent that follows instructions, not a
  boundary against a same-user Bash that unsets CLAUDECODE or edits settings; the sandbox is that boundary.
- Under CLAUDECODE the CLI refuses every install/uninstall (its target is the session's home by
  definition); scratch installs from inside Claude Code go through `install({ claudeHome })` in code.
- `init`, `restore` and `sync` stay allowed: they write only the project's workspace and binding, and
  the kit's stop hook asks the agent to run `sync`.
- `Bash(node *loop-setup.mjs*)` also denies an agent `node kit/bin/loop-setup.mjs …` read-only runs
  in the kit source repo; `pnpm loop-setup …` and the shim are unaffected.
- `isWorkspacePath` compares lexically; a home reached through a symlink must use the same spelling
  the link was written with (the kit writes links from the same `claudeHomeOf(env)` it compares to).
- The live kit picks this up at the next fresh container after merge (the setup script installs it);
  this session does not reinstall it (the new refusal would refuse it, by design).
