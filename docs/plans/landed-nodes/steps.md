# A done node counts for readiness only once its change has landed in HEAD (phase C, goal C5)

Goal: count a plan node as done for readiness only when its change has landed in the project's HEAD.
Background: `docs/plans/home-workspace/analysis.md` §5.10 ("Węzeł jest „done” dla krawędzi `after`
tylko wtedy, gdy jego patch wylądował"; the red-team note: `git apply --reverse --check` fails once a
later change touches the hunk's context, so record the SHA from CLEAR and check `merge-base
--is-ancestor` or the patch-id, and treat "cannot tell" as unknown, not no); `implementation-plan.md`
("Status fazy B": "predykat „landed” po SHA lub patch-id").

Why (root cause): `readyIds` (kit/trace/plan.mjs) counts a node as done the moment the loop CLEARs
it. The loop applies the verified patch to the **working tree** and does not commit (only the user
does, or a loop explicitly allowed to). So a dependent becomes ready while its prerequisite exists
nowhere but in one checkout: if the user discards it, commits it elsewhere, or never commits it, the
dependent is built on a change HEAD does not have.

## Design

### What CLEAR records (kit/loop.md, step 10 "applied")

The CLEAR note keeps its existing parts and gains machine-readable tokens (the note is the only free
field of an action; no schema change):

`base <baseSha>; patch <hash>; patch-id <stable patch-id>[; commit <sha>]; <check that passed>; <qualifier>`

- `patch-id` = `git patch-id --stable < <patch file>` (the first field), the same id git computes for
  any commit that makes exactly this change, whatever its parent, author, message or line offsets.
- `commit <sha>` only when the loop itself committed the change (a shared-branch loop the user allowed
  to commit; it commits right after the CLEAR's check).
- The user's commit may carry the existing optional trailer `Plan: LP-…` (loop.md step 11): it ties
  the commit to the node even when the commit bundles other changes.
- `loop-iteration.js` and its `<loop-verifier>` block are untouched (the Lead composes the note).

### The landed table (core, pure: new `kit/trace/landed.mjs`)

`landedStatus(clear, facts)` → `"landed" | "unknown"` plus a `why`, for a done node whose CLEAR note
is parsed by `landingOf(note)` → `{ base, patchId, commit }` (each or null). `facts` come from the
adapter:

| the node's CLEAR carries | fact (adapter, git) | status |
|---|---|---|
| a human `LAND` action on the node's record with `--ref` the node (below) | — | landed (human) |
| `commit <sha>` | the commit is an ancestor of HEAD (`merge-base --is-ancestor`, exit 0) | landed (ancestor) |
| `patch-id <id>` | a non-merge commit in HEAD's history since `base` has that patch-id (`git log -p base..HEAD` → `git patch-id --stable`) | landed (patch-id: merge, squash of exactly this change, cherry-pick) |
| any | a commit in HEAD's history since `base` has the trailer `Plan: <node id>` | landed (trailer) |
| `commit`/`patch-id`, none of the above | — (or git cannot tell: an unknown base, a shallow clone) | **unknown** |
| neither `commit` nor `patch-id` (a node done before this change) | — | landed (legacy), with a `[done-legacy]` warning |

"Cannot tell" is unknown, never "not landed": a later commit that edits the lines next to the hunk
changes nothing (patch-ids are per commit, so the landing commit keeps its id), which is exactly where
`git apply --reverse --check` gives a false negative.

### The landed port (readiness, plan-items, plan-lint)

- `readyIds(nodes, { state, landed })`, `planItems(nodes, ids, state, { landed })`,
  `planViolations(plan, state, { landed })` take `landed`: a `Map(nodeId → { status, why })` for the
  done nodes, computed once by the adapter. **Only `landed` satisfies `after`**; a done node that is
  `unknown` keeps its dependents waiting (`plan-items` refuses them: "waits on LP-x (done, not landed
  in HEAD)").
- Without `landed` (library callers, tests), every done node counts as landed: today's behaviour.
- `plan-lint` warns `[done-unlanded] LP-x: done, but its change (patch-id …) is not in HEAD's
  history — commit it (a "Plan: LP-x" trailer ties a combined commit), or a human records
  LAND`, and `[done-legacy]` for a legacy done node. Warnings, not errors: a CLEARed change waiting
  for the user's commit is a normal state, not a broken plan.
- Adapter: `kit/trace/cli.mjs` builds `landed` with git in the project (`merge-base --is-ancestor`,
  `git log -p --no-merges <base>..HEAD | git patch-id --stable`, `git log --format=%B <base>..HEAD`
  for trailers), behind one function `landingFacts(git, clear)`; the decision stays pure.

### The human override: a new consumer action `LAND` (chosen at the checkpoint; policy v4 → v5)

A human records that a node's change landed although git cannot show it (a combined commit without
the trailer, a rewrite, a rebase onto another base):

`loop-setup act <the node's record> human LAND --ref <node> --note "<commit or reason>"`

- `LAND` is allowed on `accept`/`qualify` (the node's licensing verifier record), with consumer
  `human` only, and `--ref` naming the node; the writer refuses it otherwise.
- It is a human's step: refused from inside Claude Code (`CLAUDECODE` set), like `anchors reset`.
- `kit/schema/schema-v1.json`: the action enum gains `LAND`; `kit/rules/trace-policy.md`: a row in the
  consumer-action table (`| LAND | accept, qualify | human (a node's change landed where git cannot
  show it) |`), the *Human release* paragraph names it, the marker goes to 5 with its sentence; the
  contract test pins version 5 (C4's exact-4 assertion becomes the v4 contents check it really is:
  the policy moved to v5 for `LAND`, nothing it asserted changed).

### Legacy rule

A done node whose CLEAR note has neither `patch-id` nor `commit` (every node CLEARed before this
change) counts as landed, so existing plans behave the same, and `plan-lint` warns `[done-legacy]` once
per such node.

## Tests first

- `kit/trace/landed.test.mjs` (pure): `landingOf` over notes (old format, new format, with and
  without `commit`, junk); every row of the table; the port in `readyIds`, `planItems`,
  `planViolations` (`[done-unlanded]`, `[done-legacy]`); no `landed` = today's behaviour.
- `kit/trace/landedrepo.test.mjs` (real git, a temp repo; the CLI as a process with a plan and a
  store): a node's patch applied and CLEARed with its patch-id, then
  - merged (a merge commit of a branch carrying it) → landed; the dependent becomes ready;
  - squash-merged (two commits on a branch, squashed into one) → landed;
  - cherry-picked onto main → landed;
  - left on an unmerged branch → unknown: the dependent is not ready, `plan-items` refuses it,
    `plan-lint` warns `[done-unlanded]`;
  - a later commit editing the lines next to the hunk → still landed, while `git apply --reverse
    --check` of the same patch fails (the false negative this avoids);
  - a combined commit with a `Plan: LP-x` trailer → landed; a human `LAND` → landed, and `LAND`
    is refused under `CLAUDECODE` and for a consumer other than `human`;
  - a legacy CLEAR note (no patch-id) → landed with `[done-legacy]`.

| id | description | scope | check | after | status | commit |
|---|---|---|---|---|---|---|
| S01 | Tests first (RED): the pure table and port; the real-git scenarios | kit/trace/landed.test.mjs, kit/trace/landedrepo.test.mjs | `pnpm exec vitest run kit/trace/landed.test.mjs kit/trace/landedrepo.test.mjs` | — | done | — |
| S02 | Core: `landed.mjs` (`landingOf`, `landedStatus`); the port in `readyIds`, `planItems`, `planViolations` | kit/trace/landed.mjs, kit/trace/plan.mjs | same | S01 | done | — |
| S03 | Adapter: `landingFacts` and the `landed` map in `plan-ready`, `plan-items`, `plan-lint`, `status` | kit/trace/cli.mjs | same | S02 | done | — |
| S04 | The loop and policy v5: the CLEAR note's `patch-id`/`commit` tokens (loop.md, the planning guide); the `LAND` action (schema, ACTION_ALLOWED, the writer's human-only and CLAUDECODE rules, the policy table, marker 5, contract test) | kit/loop.md, kit/docs/planning-guide.md, kit/rules/trace-policy.md, kit/schema/schema-v1.json, kit/trace/lib.mjs, kit/trace/cli.mjs, kit/trace/contracts.test.mjs | `pnpm exec vitest run scripts/template-docs.test.mjs kit/trace/contracts.test.mjs` | S03 | done | — |
| S05 | Self-verify chain and the post-implementation critic round | — | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` | S04 | planned | — |

RED → GREEN:
- Before S02: `landed.test.mjs` did not load (no `landed.mjs`). With the pre-change `plan.mjs` and
  `cli.mjs` (git stash), `landedrepo.test.mjs` fails 3 of 7: the unmerged branch (the dependent was
  ready), the combined commit without a trailer (ready), and `LAND` (unknown action handling); the
  other 4 pass there too, as they should (they guard against false negatives: merge, squash,
  cherry-pick, a later nearby change).
- After S02–S04: `landed.test.mjs` + `plan.test.mjs` 87/87; `landedrepo.test.mjs` 7/7; full
  `pnpm test` 26 files, 1005 tests.
- Changed expectations (root causes): C4's `chainrepo.test.mjs` asserted `policy_version: "4"` on a
  chained record; the policy is v5 since `LAND`, so it asserts "4 or later" (chains need v4); C4's
  contract test pinned version 4 exactly and now checks the v4 contents with "≥ 4", while a new test
  pins 5. `cli.test.mjs`'s throwaway-repo harness copies an explicit module list; it gained
  `landed.mjs` (a file list, not an assertion).
