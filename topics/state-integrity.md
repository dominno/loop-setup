# Workspace state and record integrity (phase C)

What the kit keeps outside the workspace, and when a done node counts. These hold for a kit
from `main` at or after edb81bf; a container whose installed kit is older still runs the
older behaviour (check with `loop-setup doctor` and `git -C <kit repo> log -1`).

- A workspace's git dir lives in `~/.claude/loop-setup/state/<id>.git`, outside the workspace.
  Every state-git call names it with `--git-dir`/`--work-tree` plus hardening flags
  (`core.hooksPath=/dev/null`, `core.fsmonitor=`, `core.autocrlf=false`, a pinned identity),
  after a pure guard (`kit/setup/stateguard.mjs`) that refuses a non-template `.gitattributes`,
  any `.gitmodules`, git-dir entries such as `commondir` or alternates, and config keys off its
  allowlist; the CLI then exits 2. An old in-workspace `.git` is rebuilt there (same HEAD and
  history) on the next sync or restore. <!-- rec:TR-790dd8d478f3 -->
- Since policy v4 every line the CLI appends is `trace-lite/1.1` with a per-writer hash chain
  (`chain {w, prev}`) and `provenance.workspace`. Each machine anchors checkpoints in
  `~/.claude/loop-setup/anchors/<id>.jsonl` (writer id in `.writer`, store lock in `.lock`);
  `loop-setup lint`, `doctor` and the SessionStart hook fail on a rewritten line or a dropped
  count and never re-anchor over a failure. The evidence is local to a machine that kept its
  anchors. `loop-setup anchors reset --reason` acknowledges a real drop and is refused from
  inside Claude Code. <!-- rec:TR-747a45d0eb3b -->
- A kit older than policy v4 rejects `trace-lite/1.1` lines: its `loop-setup lint` exits 1 with
  schema errors (`schema_version` must equal `trace-lite/1.0`; unknown `chain` and
  `provenance.workspace`) that do not say "upgrade", so its sync gate fails too. Every machine
  sharing a workspace needs a v4+ kit before the first 1.1 line is written (observed with
  installed kit 2dd64dd against main edb81bf). <!-- rec:TR-85aff7cd2be3 -->
- The record store lock (`anchors/<id>.lock`) is waited on for 10 s, then a write fails with
  "the record store is locked by another loop-setup process". Since 74a9b73 `sync` holds it only
  for its local steps (the migration; lint, commit, merge, lint) and `restore` only for its
  merge, never across a fetch or a push. <!-- rec:TR-bc3bcd80c361 -->
- Since policy v5 a done plan node satisfies `after` only once its change is in HEAD: its
  CLEAR's `commit` is an ancestor, its `patch-id` appears in HEAD's history, or a commit
  carries the trailer `Plan: <node>`. Otherwise it is unknown and `plan-lint` warns
  `[done-unlanded]`; nodes CLEARed before this change count as landed with `[done-legacy]`. A
  human `loop-setup act <record> human LAND --ref <node>` overrides; it is refused from inside
  Claude Code and allowed only on the node's latest record. <!-- rec:TR-4b94a2d88dbc -->

Related: [trace](./trace.md) (the policy) · [workflow](./workflow.md) (the workspace and
`/dream`) · [testing](./testing.md) (the lock probes)
