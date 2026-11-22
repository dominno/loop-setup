# A tamper-evident record store: per-writer hash chains and anchors outside the workspace (phase C, goal C4)

Goal: make the record store tamper-evident: a per-writer hash chain on every new record and action,
with checkpoints anchored outside the workspace.
Background: `docs/plans/home-workspace/analysis.md` §5.10 ("łańcuch per autor przetrwa union merge i
rebase") and §5.11 (trace-lite/1.1, `chain {w, prev}`, `provenance.workspace`, policy v3 → v4);
`implementation-plan.md` ("Status fazy B": "łańcuch per autor").

Why (root cause): records and actions carry content-hash ids, so `loop-setup lint` catches a line
edited in place. Nothing catches a line **deleted** (or a deletion plus a forged, self-consistent
insert): the store is append-only by convention only, and it lives in the writable workspace.

## Design

### What is hashed (core, pure: new `kit/trace/chain.mjs`)

- **A line's digest** is `sha256` of the line exactly as stored: the UTF-8 JSON text, without the
  trailing newline. The writer hashes the text it appends; lint hashes the raw text it reads.
- **Schema `trace-lite/1.1`** (additive): a record or action may carry `chain: { w, prev }`:
  - `w`: the writer id, 16 lowercase hex characters;
  - `prev`: the digest of the previous line **written by the same `w`**, in store order (archives in
    year order, then the active store), or `null` for that writer's first line.
  - A record also carries `provenance.workspace`: the workspace id, or `null` (a scratch store).
  - `chain` is part of the content the id hashes, so it cannot be edited without breaking the id.
- **1.0 lines replay unchanged** as an **unchained prefix**: the run of lines without `chain` at the
  start of the stream. A 1.1 line must carry `chain` and policy ≥ 4; a 1.0 line must not carry it.
  An unchained line after the first chained line is an error (an old kit wrote it, or someone
  inserted it; either way it is outside every chain).
- `chainViolations(entries)`: for each writer, in stream order, every line's `prev` equals the digest
  of that writer's previous line (`null` for its first). So editing a middle line breaks its id and
  its successor's `prev`; deleting a middle line breaks its successor's `prev`.
- `nextChain(entries, w)`: `{ w, prev }` for the next line `w` appends (the digest of its last line).
- Idempotency is unchanged: `contentKey` (duplicate-draft detection) ignores `chain`, so a re-run
  write of the same draft is still refused as a duplicate even though its `prev` would differ.

### Checkpoints (anchors) — per writer, because a union merge reorders writers

A merge places another writer's lines **before** mine (`base + theirs + mine` after I fetch a merge
made elsewhere), so an absolute "line n of the file" is not stable across merges. Each writer's own
subsequence is stable (union merge and rebase keep each side's order), and so is the unchained
prefix (all of it predates chaining). A checkpoint therefore names a stream:

- `{ w, n, sha }`: the stream of writer `w` has at least `n` lines and its `n`-th line's digest is
  `sha`. With the chain, that pins the writer's whole first `n` lines.
- `{ w: null, n, sha }`: the unchained prefix has at least `n` lines and its rolling digest at `n`
  is `sha` (`h_i = sha256(h_{i-1} + "\n" + line_i)`, `h_0 = ""`): 1.0 lines have no chain of their own,
  so the rolling digest stands in for one.
- `checkpointsFor(entries)`: one checkpoint per stream (the prefix and every writer present).
- `anchorViolations(entries, anchors)`: every checkpoint ever anchored must still be a prefix of its
  stream: the stream is at least `n` long (**the count never drops**) and the digest at `n` matches.

### Where the writer id and the anchors live (adapter: new `kit/setup/anchors.mjs`; paths pure in `layout.mjs`)

| path | holds |
|---|---|
| `~/.claude/loop-setup/anchors/<key>.writer` | this machine's writer id for that store (16 random hex), created on first write |
| `~/.claude/loop-setup/anchors/<key>.jsonl` | the checkpoints, one JSON line per anchoring: `{ at, checkpoints: [{ w, n, sha }] }` |

`<key>` is the workspace id; a store with no workspace id (a scratch copy via `LOOP_SETUP_WORKSPACE`
or `TRACE_STORE`) uses `store-<first 16 hex of sha256(realpath of the store)>`. Both files are
machine-local: outside the workspace, the `claude/loop-state` branch and the per-project grant, so
each machine (and each workspace on it) has its own writer id, and a write into the workspace can
neither change a writer's id nor its anchors. Appends to the store take an `O_EXCL` lock
(`anchors/<key>.lock`, retried briefly, stale after 30 s) so two local processes cannot fork one
writer's chain.

### Who does what

- **Writer** (`loop-setup write`/`act`, `kit/trace/cli.mjs` → `writeRecords`/`appendActions`): gets
  the writer id (create on first use), fills `chain` and `provenance.workspace`, stamps
  `schema_version: trace-lite/1.1` and the policy version; within a batch each line chains to the one
  before it. Library callers that pass no writer keep writing 1.0 lines (the existing API and its
  tests unchanged); the CLI, the only production writer, always chains.
- **`loop-setup lint`**: replay as today, plus `chainViolations` and, when the store has a key with
  an anchors file, `anchorViolations` (errors, exit 1). `sync` runs lint before it pushes, so a broken
  chain is not pushed.
- **SessionStart hook**: verifies the chains and every existing checkpoint; when both hold, appends
  the current checkpoints (one line); when either fails, it says so in the injected context
  (`- Record store integrity check FAILED: <first problem> — not re-anchored; run loop-setup lint`)
  and appends nothing. It never re-anchors over a failure.
- **`doctor`**: one check, "record store chain and anchors": ok with the counts, fail with the first
  problem.

### Merge semantics

`trace/*.jsonl` stays `merge=union` (the template is unchanged, so C3's template digest still holds).
Two writers append on two machines; a merge keeps both sides' lines and each side's order, so every
writer's chain and every checkpoint stay valid. A rebase replays one side's lines after the other's:
same property. What turns lint red: an edited line (id and successor's `prev`), a deleted middle
line (successor's `prev`), a deleted last line (the anchored count), an unchained line inserted
after chaining began, a forged or reordered line in the unchained prefix (its rolling digest).

### Policy bump

- `kit/rules/trace-policy.md`: `trace-policy-version: 3` → `4`, with the sentence "v4 adds the
  per-writer hash chain (schema trace-lite/1.1) and machine-local anchors; records written under
  v1–v3 replay unchanged"; a **Tamper evidence (policy v4)** bullet in *Record guarantees*; the
  *Version legibility* bullet names schema 1.1. The evidence-standard and consumer-action tables do
  not change.
- `kit/schema/schema-v1.json`: `schema_version` accepts `trace-lite/1.0` and `trace-lite/1.1`;
  `chain` (records and actions) and `provenance.workspace` defined.
- Contract tests (`kit/trace/contracts.test.mjs`): the policy version is 4; the page documents the
  chain fields the schema defines; the committed store replays with no chain error.
- `<trace-evidence-gate>` (lib.mjs + 7 workflow copies) and `<loop-verifier>` are untouched; their
  parity tests stay green.

## Tests first

- `kit/trace/chain.test.mjs` (pure): digests, `nextChain`, a batch chaining to itself, every
  violation (edit, middle delete, unchained after chained, fork), `checkpointsFor`, `anchorViolations`
  (count drop, digest change, prefix rolling digest), interleaved writers.
- `kit/trace/lib.test.mjs`: `writeRecords`/`appendActions` with a writer produce 1.1 lines that
  chain; duplicate-draft refusal still holds with a different `prev`; replay rejects 1.1 without
  `chain`, 1.0 with `chain`, 1.1 under policy 3.
- `kit/setup/chainrepo.test.mjs` (real git, the `lifecycle.test.mjs` harness: a bare remote, two
  homes, the installed shim as a process): two writers write records and actions and sync (union
  merges) → lint green on both, distinct writer ids; a rebase of one side onto the other → lint
  green; editing a middle line → red; deleting a middle line → red; SessionStart writes the anchors;
  deleting a writer's last line → lint, doctor and SessionStart all report the dropped count and
  the anchors file is not appended to.
- `kit/trace/contracts.test.mjs`: the policy bump and the page/schema agreement.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first (RED): chain core, writer and replay, real-git two-clone test, contracts | kit/trace/chain.test.mjs, kit/trace/lib.test.mjs, kit/setup/chainrepo.test.mjs, kit/trace/contracts.test.mjs | `pnpm exec vitest run kit/trace/chain.test.mjs kit/trace/lib.test.mjs kit/setup/chainrepo.test.mjs kit/trace/contracts.test.mjs` | — | planned | — |
| S02 | Core: `chain.mjs` (digest, chainViolations, nextChain, checkpointsFor, anchorViolations); schema 1.1; replay rules for 1.0/1.1 | kit/trace/chain.mjs, kit/trace/lib.mjs, kit/schema/schema-v1.json | same | S01 | planned | — |
| S03 | Adapters: anchors paths (layout.mjs), `anchors.mjs` (writer id, checkpoints, lock); the CLI writer and lint | kit/setup/layout.mjs, kit/setup/anchors.mjs, kit/trace/cli.mjs, kit/trace/lib.mjs | same | S02 | planned | — |
| S04 | SessionStart anchoring and its failure line; the doctor check | kit/setup/hooks.mjs, kit/setup/commands.mjs | same | S03 | planned | — |
| S05 | Policy v4: trace-policy.md marker, sentence and Record guarantees bullet | kit/rules/trace-policy.md | `pnpm exec vitest run kit/trace/contracts.test.mjs` | S04 | planned | — |
| S06 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S05 | planned | — |
