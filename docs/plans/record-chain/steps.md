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

## Revisions from the pre-implementation round (taken before any code)

The design above was approved at the checkpoint; the pre-implementation round (tree
e99b66087f42e547, single-pass reviewer, code-only) then found gaps, all taken here. A first run of
that round could not be recorded: the writer refused one draft for a bench ground-truth token in its
`counter_reasons`, so per the consumer protocol nothing from that batch was acted on, and the round
was run again; the second run's records are TR-9b325336d7bf … TR-05e230f34069.

1. **Every CLI writer chains** (TR-9b325336d7bf): one `chainedWriter()` composition in `cli.mjs` is
   used by all five store writers — `write`, `write --then-act`, `act`, `reaudit --act`,
   `bench-score --record` — and by `rotate`. Library callers without a writer still write 1.0 lines.
2. **Chain after dedupe** (TR-6d5893f4387f, TR-4c861a3d01be): `chain` is assigned only to the lines
   that will actually be appended (after no-op dedupe and screening), through a pure
   `chainBatch(entries, w, lines)` that starts from `nextChain` and threads `prev` through the batch;
   the id is computed after `chain` is set. Every dedupe key stays chain-free: `contentKey` drops
   `chain`, and the in-batch event dedupe uses `contentKey` + `created_at`, not the chained id.
3. **The writer owns `chain` and `provenance.workspace`**: `finalizeRecord`/`finalizeAction` refuse a
   draft that carries `chain`, and set `provenance.workspace` after the draft is merged.
4. **Chains are checked in `replay`** (pure; `parseLines` keeps each line's `raw`), so every reader —
   lint, the contracts test, wiki-check — fails closed on a broken chain; only the anchor comparison,
   which needs machine-local files, is in the adapters.
5. **The legacy prefix is a set, and a late unchained line is a warning** (TR-ea1382b09a25,
   TR-05e230f34069): a merge with a machine still on an older kit can place 1.0 lines after chained
   ones, and union order depends on which side merges. So:
   - an unchained line (schema 1.0, policy ≤ 3) after the first chained line is a **warning**
     ("written by a kit older than policy v4 — upgrade every machine that shares this workspace"),
     never an error, and belongs to no chain;
   - the legacy checkpoint is `{ w: null, n, ids }`: the sorted ids of every unchained line. It holds
     while every anchored id is still in the store (order-independent); `n` never drops.
6. **The writer anchors its own lines** (TR-2684185404a4): after a successful append, under the same
   lock, the writer appends its stream's checkpoint, so a writer's tail is never unanchored on its
   own machine. SessionStart still verifies everything and anchors every stream it sees (other
   writers' lines arrive by merge). An anchors line is appended only when a checkpoint advanced.
7. **One lock** (TR-177f4ecd5b23): `withStoreLock(key, fn)` in `anchors.mjs` covers load → chain →
   append → anchor append in every writer, `rotate`, and `sync` (its commit and merge rewrite the
   store). The lock file holds `{ pid, host, at }`; a lock whose process is gone on this host is broken
   by an atomic rename, any other is waited for (10 s) and then refused with a clear message. The
   `.writer` file is created with `O_EXCL`.
8. **The key** (the first run's blocker, confirmed again by the code): `<key>` comes from `stateIdOf`
   (layout.mjs), so a store inside a real workspace keeps its workspace id even under
   `LOOP_SETUP_WORKSPACE` (sync's lint gate runs that way); `store-<hash>` is only for stores outside
   `workspaces/`.
9. **Missing anchors are visible** (TR-fbcce4b1397a): `.writer` exists ⇒ an anchors file must exist
   (the writer creates both); otherwise lint and doctor fail. A chained store with no anchors at all on
   this machine is a warning ("tamper evidence holds only where the anchors were kept"). An exception
   or an unparsable anchors line inside the SessionStart integrity step becomes the failure line in the
   injected context, never a silent skip.
10. **Recovery**: a real count drop (a workspace restored from a remote that is behind lines this
    machine anchored) keeps lint red until a human acknowledges it: `loop-setup anchors reset
    --reason "<why>"` moves the anchors file aside (`<key>.jsonl.reset-<UTC>`) and starts a new one
    whose first line records `{ reset: { at, reason, previous } }`. It is refused from inside Claude
    Code for the session's own home, like `install` (a human's step); `doctor` shows the last reset.
11. **Digest and eol** (nice-to-have taken): the digest is over the line with one trailing `\r`
    stripped, so a CRLF checkout does not break chains.
12. **The guarantee, stated precisely** (policy bullet): on a machine that kept its anchors, an edit or
    deletion of an anchored line is detected; insertion of new lines, authorship (writer ids are not
    secrets) and tampering with the machine-local anchors themselves are not. The workspace's own
    `topics/trace.md` is a wiki page and is not rewritten by this change.
13. **Tests added to S01** (TR-5a812bfd5cbe): the two-clone test asserts the merged line order and has
    a 1.0 writer on one side; a no-op in the middle of an action batch; two identical REUSE drafts in
    one batch; a draft carrying `chain`; rotation across a year boundary keeps every chain and
    checkpoint; two concurrent `write` processes leave lint green; deleting `.writer`/the anchors file;
    a corrupt anchors line; `anchors reset` (and its refusal under `CLAUDECODE`); sync stopping at
    pre-lint on a dropped anchored count.

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
| S01 | Tests first (RED): chain core, writer and replay, real-git two-clone test, contracts | kit/trace/chain.test.mjs, kit/trace/lib.test.mjs, kit/setup/chainrepo.test.mjs, kit/trace/contracts.test.mjs | `pnpm exec vitest run kit/trace/chain.test.mjs kit/trace/lib.test.mjs kit/setup/chainrepo.test.mjs kit/trace/contracts.test.mjs` | — | done | — |
| S02 | Core: `chain.mjs` (digest, chainViolations, nextChain, checkpointsFor, anchorViolations); schema 1.1; replay rules for 1.0/1.1 | kit/trace/chain.mjs, kit/trace/lib.mjs, kit/schema/schema-v1.json | same | S01 | done | — |
| S03 | Adapters: anchors paths (layout.mjs), `anchors.mjs` (writer id, checkpoints, lock, reset); `chainedWriter()` at all five CLI writers and rotate; lint; sync under the lock | kit/setup/layout.mjs, kit/setup/anchors.mjs, kit/trace/cli.mjs, kit/trace/lib.mjs, kit/setup/workspace.mjs, kit/setup/commands.mjs | same | S02 | done | — |
| S04 | SessionStart anchoring and its failure line; the doctor check | kit/setup/hooks.mjs, kit/setup/commands.mjs | same | S03 | done | — |
| S05 | Policy v4: trace-policy.md marker, sentence and Record guarantees bullet (the precise guarantee, the upgrade rule); `anchors reset` in the adoption guide | kit/rules/trace-policy.md, kit/docs/adoption-guide.md | `pnpm exec vitest run kit/trace/contracts.test.mjs` | S04 | done | — |
| S03.1 | Pre-round revise TR-2684185404a4 (its repair and failed gates): under the L3 sandbox a writer cannot write `~/.claude/loop-setup/anchors/`, so the hooks (outside the sandbox) create the writer id and the anchors file and anchor every stream — SessionStart and now the Stop hook too (verified first, never over a failure); a writer runs its lock and its own checkpoint best-effort when the directory is not writable, and fails closed only when it has no writer id at all | kit/setup/anchors.mjs, kit/setup/hooks.mjs, kit/trace/cli.mjs, kit/setup/chainrepo.test.mjs | `pnpm exec vitest run kit/setup/chainrepo.test.mjs` | S04 | done | — |
| S06 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S05 | planned | — |

RED → GREEN:
- Before S02: `chain.test.mjs` did not load (no `chain.mjs`); 4 chained-writer tests in `lib.test.mjs`
  failed; the policy-v4 contract test failed; `chainrepo.test.mjs` could not pass (no writer).
- On the way, two root causes, fixed in the code (no expectation changed):
  - duplicate-draft detection compared a stored 1.1 line with its 1.0 candidate, so the same draft
    was not a duplicate: `contentKey` now drops every chain-owned field (`chain`, `schema_version`,
    `provenance.workspace`), so dedupe is chain-free;
  - 16 `cli.test.mjs` tests failed with exit 1 because their throwaway-repo harness copies an explicit
    list of kit modules and the CLI now imports `kit/trace/chain.mjs` and `kit/setup/anchors.mjs`;
    both were added to that list (a harness file list, not an assertion).
- After S02–S05: `pnpm exec vitest run kit/trace kit/setup` → 651 + 226 passed; full `pnpm test`
  23 files, 979 tests.
- Not taken: owned Edit-deny rules for `~/.claude/loop-setup/anchors/**` (raised only in the
  unrecorded first run; `integrity.test.mjs` pins the exact owned deny list) — under Remaining risks.

Live evidence (read-only, this machine): the new `lint` on the real store (184 lines, all 1.0) → ok,
0 errors, 0 warnings; the new `doctor` → `ok record store chain and anchors — 0 checkpoint(s)
anchored`; no anchors directory was created by either.
