# Memory Log

Append-only record of wiki operations. Newest entries at the bottom. Prefixes:
`ingest` (new learnings filed), `lint` (health-check), `migrate` (structure
change), `rotate` (archived old entries). Format: `## [YYYY-MM-DD] <op> | <summary>`.

> **Rotation:** when this file passes **500 lines**, `/dream lint` moves the older
> entries into yearly archives at `.claude/memory/log/<YYYY>.md` (created on demand)
> and leaves the recent entries here, then logs a `rotate` entry. Archives are read
> only when deep history is needed. This file is never `@imported`, so its size
> costs nothing per session — rotation is purely to keep reads/appends cheap.

## [2026-06-27] ingest | Initial durable learnings
- Seeded tooling, build & verify, testing, code organization, remote-env, and
  workflow facts from the loop-setup and starter-app work.

## [2026-06-27] ingest | US-002 "remember me" learnings
- Added `useSyncExternalStore`/hydration + same-tab `storage` event +
  SSR-guarded `src/lib` wrapper facts → topics/client-react.md.
- Added Playwright per-test `localStorage` isolation + `vi.stubGlobal` facts →
  topics/testing.md.

## [2026-06-27] migrate | Adopt Karpathy LLM-wiki structure
- Replaced the single `.claude/memory.md` with `index.md` + `topics/*` + this
  `log.md`. No facts removed; each former section became a topic page.
- `CLAUDE.md` now imports only `.claude/memory/index.md` (small, always-loaded);
  topic pages are read on demand to keep per-session context flat as memory grows.

## [2026-06-27] lint | First health-check of the wiki
- Index ↔ topics in sync (7/7 rows resolve); no broken cross-links, no
  contradictions, no stale claims.
- Fixed one semi-orphan: `topics/workflow.md` had no inbound cross-links from
  sibling pages. Added reciprocal links between `workflow.md` and
  `build-and-verify.md`. Every page now has an inbound link beyond the index.

## [2026-06-27] ingest | Skills-system + adoption edge-case learnings
- Added to topics/workflow.md: command `description` enables model auto-invocation
  (use `disable-model-invocation: true` for manual-only); team perms belong in
  committed `settings.json`, and git auto-allow is opt-in.
- Source: critic round on the skills-index changes + adoption-guide hardening
  (stale seeded facts, verify-chain trimming, name collisions, monorepo, import
  path, permissions).

## [2026-06-27] migrate | Added log rotation rule (>500 lines)
- `/dream lint` now rolls older entries into yearly archives
  `.claude/memory/log/<YYYY>.md` once this file passes 500 lines, keeping a recent
  window here. Documented in `index.md` and the log header. Lossless move; the log
  is never `@imported`, so this is about read/append cost, not session context.

## [2026-06-27] ingest | Let the agent write its own /goal
- Adopted the "agent writes its own /goal" principle (Boris Cherny): CLAUDE.md now
  has a "Writing /goal and /loop prompts" section (power-move offer + six-part goal
  checklist + 3 methods + triggers), a new `/write-goal` command, and a
  skills-index row. Filed the principle in topics/workflow.md.
- Source: audit of the template against the "/goal authoring" guidance.

## [2026-06-27] ingest | CI workflow learnings
- Added to topics/remote-env.md: CI (GitHub Actions) has no pre-provisioned
  browser, so it runs the normal `playwright install --with-deps chromium` (not the
  web env's SKIP flag); CI runs parallel jobs (matrix + e2e); `process.env.CI` makes
  Playwright start a fresh server.
- Source: adding `.github/workflows/verify.yml` (parallel-jobs CI).

## [2026-06-28] migrate | User stories → one file per story
- Split the monolithic `docs/user-stories.md` into per-story files under
  `docs/stories/US-<id>-<slug>.md` (+ `_TEMPLATE.md`); `user-stories.md` is now the
  index and `implementation-status.md` the dashboard. Scanner commands + CLAUDE.md
  doc-scanner list + README/adoption-guide updated. Scales the backlog for a large
  project (same reasoning as the memory wiki / log split). Stacked on PR #8.

## [2026-06-28] ingest | Loop hardening ("loop engineering")
- Integrated concepts from github.com/cobusgreyling/loop-engineering: trust levels
  (L1/L2/L3), denylist + escalation rubric, red-flag stop conditions, and a
  budget/run-log into `.claude/loop.md`; added `.claude/loop-checklist.md`
  (readiness rubric) and `.claude/memory/loop-run-log.md` (append-only loop state,
  with the >500-line rotation rule). Added the maker/checker no-self-approve rule
  and `Agent isolation: worktree` note to CLAUDE.md. Filed the principle in
  topics/workflow.md.

## [2026-06-29] migrate | Critic rounds → deterministic multi-agent Workflows
- Replaced "simulate critics" (one agent role-playing the panel) with real
  orchestration: added `.claude/workflows/critic-panel.js` (parallel critics →
  adversarial verify → matrix) and `.claude/workflows/scan-docs.js` (per-story
  parallel evidence → separate status verifier). Rewired `/critic-round`,
  `/multi-agent-dev`, `/multi-agent-e2e`, `/qa-pass`, `/scan-project-docs` to invoke
  them via the Workflow tool. Named the workflow `critic-panel` (not `critic-round`)
  to avoid colliding with the command in the skills list.

## [2026-06-29] ingest | More orchestration workflows + review fixes
- Added `gap-analysis.js` (→ `/story-gap-analysis`), `e2e-design.js` (→
  `/multi-agent-e2e`), and `loop-iteration.js` (maker/checker for `/loop` L2/L3).
  Wired the commands + `.claude/loop.md`; updated README, CLAUDE.md, skills-index,
  adoption-guide (new "Multi-agent orchestration (Workflows)" section).
- From PR #10 review: verifier agents now fail safe (null verdict ⇒ not confirmed),
  parallel agents get unique labels (map index), schema-required fields get fallback
  strings, and `scan-docs` statuses are capped at "E2E tested" (browser pass is the
  caller's job). Filed the workflow-authoring gotchas in topics/workflow.md.

## [2026-06-29] lint | Ran critic-panel-style Workflow on the workflow scripts
- Dogfooded a real multi-agent review (18 agents) over `.claude/workflows/*`: 1
  blocker + 10 important confirmed, 0 refuted. Fixes applied:
  - scan-docs: guard the first-stage `evidence` result (blocker — unguarded deref
    crashed the pipeline); fail CLOSED on a missing verdict (cap the maker's
    self-proposed status) instead of accepting it.
  - critic-panel: `.filter(Boolean)` the verified array; MERGE duplicate findings
    (keep corroborating critics) instead of dropping; optional `args.uiInScope`
    (skip the 5 UI critics for non-UI changes) and `args.priorEvidence` (verify
    against already-gathered evidence, not a re-run).
  - loop-iteration: implementer returns the REAL `git diff`; verifier reviews the
    actual diff (not a self-report) and the caller applies the returned patch; added
    a hard programmatic DENYLIST gate on changedFiles (defense-in-depth).
  - e2e-design: dedup key includes category; title coalesced before `.trim()`.
- Lesson: a maker/checker that hands the checker only the maker's self-report is
  weak — give the checker the real artifact (diff). Exact-title dedup also let one
  bug appear as two findings; merge, don't drop.

## [2026-06-29] ingest | Self-improvement axis: /improve-skills meta-critic
- The self-learning system improved only its *facts* (the wiki via `/dream`), not its
  *own prompts/workflows*. Added `/improve-skills` (`.claude/workflows/improve-skills.js`
  + `.claude/commands/improve-skills.md`): a per-lens meta-critic (clarity,
  instruction-following risk, safety/gating, consistency/DRY, workflow DSL, routing)
  over the project's OWN command/workflow/instruction surface, with a separate skeptic
  verifying each finding on two axes (problem **real** + edit **safe**). Returns
  proposed edits only — confirmation-gated, `disable-model-invocation: true`.
- Wired into CLAUDE.md (workflow list + "self-improvement vs self-learning" note),
  skills-index, and topics/workflow.md. Filed the two-axis principle there.

## [2026-06-29] ingest | First /improve-skills run found a self-modification gap
- Dogfooded `/improve-skills` (25 agents, 6 lenses): 2 blockers + 10 important
  confirmed, 7 refuted (the two-axis verifier rejected 3 "improvements" that would
  have *weakened* a gate — proof the editSafe axis works). Applied 7 fixes:
  - **Self-modification guard (blocker):** the autonomous-loop denylist protected only
    product/infra paths, so an L2/L3 loop could rewrite its OWN governing prompts.
    Added `.claude/` + `CLAUDE.md` to the `loop-iteration.js` regex gate AND the
    `loop.md` prose denylist. The sanctioned path to edit prompts is the manual,
    confirmation-gated `/improve-skills`.
  - `/dream`: gated `CLAUDE.md` edits behind explicit confirmation (was "propose and
    apply" — contradicted its own Hard rules); added the matching Hard rule.
  - `CLAUDE.md`: added "commit/push only when the user asks" (settings pre-allow
    `git commit`, but no rule said not to commit unprompted).
  - `loop.md`: fail-safe defaults — unstated per-run cap → 25 turns, unstated trust
    level → L1 at the action step, no identifiable task → self-stop (don't invent one).
  - `fix-localhost`: made its single-agent intent explicit (it was naming a critic
    panel inline, which CLAUDE.md says must be a Workflow / is single-agent).
  - `multi-agent-dev`: its "never mark complete unless" gate omitted
    typecheck/lint/unit/build that CLAUDE.md requires — added them.
  - `write-goal` + `CLAUDE.md`: removed the dangling `/plan` reference (no such repo
    command) → "outline the plan inline".
  - Hardened `improve-skills.js` to parse a JSON-string `args` (a command may pass
    args as a string; was leaking the raw JSON into `scope`).
- Lesson: a self-improving system MUST add its own prompt surface (`.claude/`,
  `CLAUDE.md`) to every autonomous denylist — otherwise the loop can edit the rules
  that constrain it. The meta-critic caught this in its own machinery on the first run.

## [2026-06-29] ingest | Graph-engineering upgrades (model tiering, budget, diagrams)
- Distilled from a "graph engineering" post (Slate/Random Labs). Our `Workflow` tool
  already IS a graph runtime (nodes=agents, edges=hand-offs, parallel/pipeline, scoped
  failure); three real gaps were closed:
  - **Model tiering** across all 6 workflows: fan-out nodes (critics, evidence, gaps,
    E2E cases, meta-critics) → `model: 'sonnet'`; gates/judgment (verifiers, status
    verifier, synthesis) → `model: 'opus'`; overridable via `args.models`. The
    `loop-iteration` implementer stays on the session model (never downgrade a
    code-writing node). Cuts fan-out cost, keeps quality at the decision points.
  - **Budget hard-stops**: `improve-skills` skips the verify fan-out below a token
    floor (findings → `needsDesign`, unverified, never auto-applied); `loop-iteration`
    escalates all items below its floor instead of failing mid-fix. Guarded on
    `budget.total` (null ⇒ no cap).
  - **Diagram-first**: `docs/workflow-graphs.md` draws every workflow's node/edge graph
    (Mermaid) with the per-node model tier — the "see the graph before you run" view.
- Filed the tiering + soft/hard-budget + diagram-drift conventions in topics/workflow.md.
- Not adopted (out of scope): the post's quant/hedge-fund framing and the standalone
  Slate runtime — we already have the graph runtime; the trading claims overstate what
  orchestration solves (data quality, costs, overfitting remain the hard part).

## [2026-06-29] ingest | Gate on the tiering change caught a denylist bypass (blocker)
- Ran `/improve-skills` (21 agents, on the NEW tiering — Sonnet fan-out + Opus verify)
  over the graph-engineering diff: 1 blocker + 7 important confirmed, 7 refuted. Fixes:
  - **Blocker — `loop-iteration` denylist bypass:** the "hard, deterministic" gate
    checked the implementer's SELF-REPORTED `changedFiles`, but the caller applies the
    real `diff`. An under-reported file list touching a denylisted path (`.claude/`,
    `.env`) would slip past. Fixed by parsing paths from the actual diff
    (`parseDiffPaths`) and gating on the UNION of diff-paths + changedFiles. Unit-tested:
    the attack (changedFiles omits `.claude/loop.md` while the diff edits it) now
    escalates. This is the same "give the checker the real artifact, not the self-report"
    lesson — it applies to the deterministic gate too, not just the LLM verifier.
  - **args normalization** ported to the other 5 workflows (the JSON-string parse lived
    only in `improve-skills`), rewiring every `args.X` read to the normalized `a` so the
    `args.models` tiering override doesn't silently no-op.
  - **`workflow-dsl` lens** now also checks model-tiering + budget-guard fail-safety;
    **`consistency-dry` lens** + `/dream lint` now check `docs/workflow-graphs.md` for
    drift vs the scripts; `docs/workflow-graphs.md` added to `improve-skills`
    DEFAULT_TARGETS (the drift check was promised but not wired).
  - **`improve-skills.md`** now documents `budgetStop` and instructs disclosing a
    skipped-verification run (needsDesign items are UNVERIFIED, not design-pending).
- Lesson: a deterministic gate is only as trustworthy as the input it reads — derive the
  checked paths from the artifact that is actually applied (the diff), never from a
  parallel self-report. The maker/checker "real artifact" rule extends to code gates.

## [2026-07-28] ingest | HTDAG loop discipline (persistent plan/DAG, re-plan node, no action without a node)
- Applied the three HTDAG planning disciplines to the loop meta-layer (not the 2-story
  product backlog — that's a deliberate workflow test-stub; the machinery is the real DAG):
  (1) a durable plan `.claude/memory/loop-plan.md` (typed nodes, `after:` edges, `ready`
  rule) the loop reads at iteration start and rewrites; (2) **re-plan as a first-class
  step run BEFORE dispatch** (loop.md step 9) so the loop consults the fresh DAG each
  iteration; (3) **no action without a node** — every L2/L3 dispatch is a ready plan node,
  node creation the only exempt bootstrap. Layered on top of the denylist + trust levels,
  never replacing them. No `.js` engine touched. Filed the discipline in topics/workflow.md.
- Maker/checker: `/improve-skills` (24 agents) confirmed **0 blockers** (no gate weakened)
  + 14 important real+safe, all applied. It caught genuine DAG-contract holes in the first
  draft — `in-progress` not excluded from the ready rule (crash-orphan → duplicate
  dispatch), and no cascade when an `after:` dep is `dropped`/`escalated` (dependents
  strand silently `blocked`). Filed the general "classify every persisted status + resolve
  every non-`done` terminal dep-state" lesson in topics/workflow.md.
- Shipped as PR #13 (merged). Wired loop-plan.md into CLAUDE.md, index.md, skills-index.md,
  loop-checklist.md §5, and the run-log format (`node:`/`re-plan:` lines).

## [2026-07-28] lint | Post-3-PR health-check — wiki clean, one flag left as-is
- Wiki in sync: 7/7 topic pages resolve from index.md, no orphans, no broken cross-links,
  no contradictions (all surfaces consistently name loop-plan.md after the HTDAG change).
- Skills index complete: 12/12 commands have a `description` and a routing row; no dead
  rows, no near-duplicates.
- Diagram drift check (`docs/workflow-graphs.md` vs `.claude/workflows/*.js`): node counts
  match — critic-panel 10 critics, improve-skills 6 lenses, gap-analysis 7 dimensions,
  e2e-design 5 categories; model tiers (🟢 fan-out / 🔵 gate) match FANOUT_MODEL/JUDGE_MODEL.
- Product/tooling topic pages (tooling, build-and-verify, testing, client-react,
  code-organization, remote-env) reviewed — all evergreen, nothing stale.
- log.md 215 lines (< 500) — no rotation.
- **Flagged, not fixed (append-only history):** several recent entries carry `[2026-06-29]`
  while later work merged ~2026-07-27/28. Left intact — the 06-29 cluster is 7 entries
  mostly from genuine prior sessions, so rewriting dates risked corrupting correct history
  more than it fixed. Reported for the record; no rewrite without a clear per-entry basis.

## [2026-07-28] ingest | Objective a11y/perf quality bar (Gauntlet "the bar")
- Evaluated Matt Shumer's "Gauntlet Loop" against the repo (via our own critic machinery):
  we already have most of it (fresh-context subagents, maker/checker, evidence-gated
  stopping). The one adoption worth it for spec-driven dev: give the Accessibility &
  Performance critics a concrete EXTERNAL bar, wired as a gate. Skipped the rest
  (aesthetic reference bar, blind A/B, forever-looping) as misfits — recorded in the eval.
- Added `.claude/memory/topics/quality-bar.md` (WCAG 2.1 AA contrast + first-load JS budget
  190 KB gzip via a machine-readable `perf-budget-kb-gzip` marker = single source of truth),
  index row, an axe e2e gate (`e2e/a11y.spec.ts`), and `scripts/check-bundle-size.mjs`
  wired into `pnpm verify`. Pointed the two critic lenses at the bar.
- Durable gotcha (also filed in topics/remote-env.md): CI uses pnpm 10; the web env's
  corepack pnpm 11 errors `ERR_PNPM_IGNORED_BUILDS`. Fixed the never-completed
  `pnpm-workspace.yaml` build-approval placeholder and regenerated the lockfile with
  pnpm 10 to match CI.
- Maker/checker: `/improve-skills` over the prompt surface returned 0 blockers + 4 real
  consistency fixes (all applied — incl. a "placeholders exempt" a11y loophole and a stale
  verify-chain doc); a separate critic-panel round over the implementation was also run.

## [2026-10-07] ingest | TRACE-lite adoption (typed verdicts, record store, consumers, bench)
- Adopted TRACE-lite from arXiv:2607.12480 in four phases: typed verdicts
  (accept/qualify/revise/defer/reject) + per-claim-type evidence gate in every
  judging workflow; the append-only record store `.claude/memory/trace/records.jsonl`
  with `pnpm trace` (write/act/query/lint/reaudit/metrics/…); consumers (`/loop`,
  `loop-plan.md`, `/dream` admission gate, `/critic-round`, `/multi-agent-dev`,
  `/qa-pass`, `/improve-skills`, doc scanner); TRACE-Bench-lite (`trace-bench.js`,
  encoded fixture bundle, `pnpm trace bench-judge`, F0–F5 flags). Policy page:
  `topics/trace.md`.
- Maker/checker: critic-panel round 1 (25 confirmed, all fixed), `/improve-skills`
  (findings closed), round 2 (0 blockers, 18 important, all fixed with tests; not
  re-reviewed by a third round — on record as HOLD).
- Bench: loop verifier WrongAcceptRate 0 / FalseHoldRate 0 on clean runs, recorded as
  `qualify` (4 of 33 runs excluded as contaminated). The verifier prompt changed
  afterwards, so the L3 measured-checker gate needs a re-bench.
- Admission: committed 6 (TR-7bf1d1f3331a, TR-f57f71d953ae, TR-b2252b5e37e6,
  TR-b8824029fbed, TR-4483488be093 → trace.md; TR-462e7e971072 → testing.md),
  qualified 1 (TR-6ab38b2e15ac → workflow.md), quarantined 0, rejected 1
  (TR-e72828345c91, duplicate). `pnpm trace lint`: ok, 57 records.

## [2026-10-08] ingest | Third checker round on TRACE-lite + clean bench re-run
- Third critic-panel round (wf_d01e03e0-e1f, 5 non-UI critics) over the round-2 fixes:
  0 blockers, 24 important (~9 distinct issues); the round-1/2 findings it no longer raised
  were CLEARed. Fixed: mixed-format patches past the denylist (git's own parse, pre-apply,
  HEAD-sourced denylist), unreachable `bench-judge --recover`, F0 coverage gaps (run ids),
  `--brief` dropping qualifiers, `act --from` on empty lists, unbounded REAUDIT.
- Separate checkers (subagents) re-verified each cluster on scratch clones and found
  second-order defects in the fixes (panel labels with digits, committed fixtures reverted
  by --recover, process-group kill on timeout, unpinned mutants) — all fixed and pinned;
  their confirmations are the CLEAR notes. The denylist cluster's checker was stopped by a
  safety classifier before testing, so those six records stay on HOLD.
- TRACE-Bench-lite re-run (wf_1f8c24eb-1f2): 33/33 transcripts scanned, no exclusions,
  verifier WrongAcceptRate 0 / FalseHoldRate 0 / invariance 1.00, single-pass recall 1.00 —
  recorded `accept` (TR-bdc16b430394); the L3 measured-checker gate is satisfied.
- Admission: committed 5 (TR-b219013814f2, TR-269d82f78a84, TR-00c2a9c72e0c,
  TR-4a5419c74c07 → trace.md; TR-4a808ff82551 → testing.md), qualified 1 (TR-3ef3eac264d4 →
  workflow.md), quarantined 1 (TR-3439a2c9a95a), rejected 1 (TR-690c19ec53fb, duplicate).

## [2026-10-08] ingest | Denylist cluster verified; explicit diff prefixes
- A separate checker (documented cases only, fresh clone) rebuilt every failing patch from
  the 8 denylist records — all now escalated by the workflow gate and refused by
  `denylist-check --patch` (git failures exit 2); 5 ordinary git-generated patches pass. The
  8 records are CLEARed. Its follow-ups are fixed and pinned: a rename header quoting only
  one side is parsed (was a fail-closed false positive), the implementer asks git for
  explicit a/ b/ prefixes, and tests now cover unborn HEAD / non-repo exit 2, a dirty
  `.claude/` tree with an innocent patch, copy-only and rename-out patches, state-file patches.
- Admission: committed 1 (TR-40be9c919489 → trace.md).
