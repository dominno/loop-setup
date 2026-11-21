# Memory quarantine

Candidate facts the `/dream` admission gate **deferred** (TRACE `defer` →
`QUARANTINE`): plausible, but not verifiable when they were proposed. They are **not**
part of the wiki — don't rely on them. Each row names the `missing` evidence that would
admit it; `/dream lint` re-checks the list and either promotes a row (new record that
`revises` it → `COMMIT` → topic page) or rejects it, then removes the row. The record
store keeps the full history (`loop-setup show <record>`).

> Not `@imported`, so it costs nothing until `/dream` opens it.

| record | candidate fact | missing (what would admit it) | since |
|---|---|---|---|
| TR-3439a2c9a95a | Parallel subagents sharing the session scratchpad can remove each other's scratch worktrees — give each its own `mktemp -d` dir | a reproduction: two subagents creating and cleaning up worktrees under one scratchpad, one removing the other's | 2026-10-08 |
| TR-325b6a5ea4fb | In Claude Code on the web, a kit installed into `~/.claude` by the environment setup script is loaded by the session (its user-scope commands and SessionStart/Stop hooks run although the runtime passes its own launcher-settings.json) | a fresh cloud session started on the updated environment showing the setup-script-installed kit's commands and its SessionStart hook output | 2026-11-21 |
