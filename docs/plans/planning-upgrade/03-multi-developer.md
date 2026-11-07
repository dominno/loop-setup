# Two developers, one project: how loop-setup behaves today and what to change (2026-11-06)

Setup assumed: two people (A, B), each with their own clone or cloud session of the same
GitHub repo, each running Claude Code (and possibly `/loop`, `/multi-agent-dev`, `/dream`),
integrating through branches and PRs into `main`.

## What already works
- **TRACE record store** — `.gitattributes` merges `.claude/memory/trace/records.jsonl` as a
  union; record ids are content hashes, so A's and B's records never collide; `pnpm trace lint`
  (run by `pnpm test` and CI) re-checks the merged store. Rotation only on `main`.
- **Permissions** — the committed `.claude/settings.json` is shared; personal allows live in the
  git-ignored `.claude/settings.local.json`.
- **Worktrees / scratch copies** are local to each machine; `/workflows` runs never share state.
- **Tree-keyed verdict reuse** (`args.treeId`) only fires on identical code, so A's critic
  verdicts are never silently reused for B's different tree.
- **CI** runs the committed-tree gates (store lint, wiki-check, story-lint, plan-lint inside
  `pnpm test`) on every PR.

## What breaks or degrades
| # | Surface | What happens with two people | Severity |
|---|---|---|---|
| D1 | `LP-NNN` node ids | Ids are sequential ("above the highest ever used"). A and B each add LP-004 on their branches → two different nodes with one id after merge; their `loop:LP-004` records fuse into one claim chain. | high |
| D2 | `loop-plan.md` table | One markdown table; two branches editing rows/appending nodes → textual merge conflicts, or a silent bad merge (a row resolved to the wrong status). `plan-lint` catches some, not a wrong-but-valid status. | high |
| D3 | `in-progress` / stale recovery | "One loop per checkout" is implicit. B's re-plan sees A's pushed `in-progress` node as stale and resets it to `ready` → both work the same node; duplicate patches, conflicting records. No owner field. | high |
| D4 | Append-only logs (`loop-run-log.md`, `.claude/memory/log.md`) | Both append at EOF → guaranteed merge conflict each time (no `merge=union`). | medium |
| D5 | Wiki / quarantine (`/dream`) | Concurrent ingests edit the same topic pages; a retire on one side + cite on the other → wiki-check errors after merge; COMMIT actions recorded against a page the other side rewrote. | medium |
| D6 | Story statuses (`docs/stories/*`, index, dashboard) | Two `/sync-story-status` runs set different statuses; union-merged story records both claim "latest" → order-dependent `[latest]`; text conflicts in the dashboard. | medium |
| D7 | CLEAR on a no-longer-newest record | After a union merge, a CLEAR made on one branch can sit on a record the other branch revised; replay only warns. | low |
| D8 | Squash merges | Orphan the provenance commits of every record (reaudit `unreachable`). Today only a docs recommendation. | medium |
| D9 | Loop trust & denylist | Unchanged per person, but A's L3 loop can dispatch nodes B is hand-editing (no claim, no file-scope conflict check across people). | medium |
| D10 | Shared `/goal`, scratchpad specs | Plans written in a personal scratchpad (as this repo's last big change was) are invisible to the other developer. | medium |

## Proposals (all part of the upgrade; see 04-spec.md workstream W5)
- **M1 Collision-free node ids** — new nodes get `LP-<4-6 hex>` (hash of description + creator + time,
  Beads-style); legacy `LP-NNN` stays valid; plan-lint `[dup-id]` error on a duplicate id after a merge.
- **M2 Owner-aware claims** — `claim:<owner>@<run-id>` in notes (owner = `git config user.email`
  local part or an explicit `LOOP_OWNER`); re-plan never resets another owner's claimed node — it
  reports it; stale is decided only from that owner's run-log entry (ended) or by a human.
- **M3 Claim through git (atomic lease)** — before dispatch at L2/L3 on a shared branch, commit the
  claim rows and push; a rejected push (someone else moved the plan) means re-read and re-plan,
  never force. Documented in loop.md; single active loop per branch remains the rule.
- **M4 Union merge for append-only logs** — add `loop-run-log.md` and `.claude/memory/log.md`
  to `.gitattributes` `merge=union`; entries must be self-contained blocks (they are).
- **M5 Plan merges are checked** — `pnpm trace plan-lint` already runs in `pnpm test`; add a
  `[dup-id]` and `[claim-conflict]` (two owners claim one node) rule; CI fails a PR with either.
- **M6 Merge-commit policy enforced** — a `pnpm trace reaudit`-based CI warning on unreachable
  provenance plus adoption-guide instruction to disable squash merges in branch protection.
- **M7 Shared planning surface** — plans for multi-step work live in the repo (`/plan` output in
  `loop-plan.md`, or the `/multi-agent-dev` step list under `docs/plans/`), never only in a
  personal scratchpad; the step list format is the same node contract (id, description, scope,
  check, after).
- **M8 Story-status ownership** — `/sync-story-status` runs on `main` only (or one PR at a time);
  story-lint `[latest]` stays a warning; the doc says to re-sync after merging two status PRs.
- **M9 /dream on branches** — wiki edits go through PRs; wiki-check in CI is the post-merge gate;
  a conflicting retire/cite is resolved by a new revising record, never by hand-editing the store.
- **M10 Team section in docs** — `docs/adoption-guide.md` gets a "Working as a team" section
  covering M1–M9, plus what stays personal (settings.local.json, worktrees, scratchpad).
