# loop-setup kit — rules

These are the kit's rules, installed with the kit into `~/.claude/loop-setup/kit/rules/KIT.md`. A project
keeps only its own rules in its `CLAUDE.md`. The kit's SessionStart hook injects the digest below
into every session of a project that has a loop workspace. The full text is here.

<!-- digest:start -->
The **loop-setup kit** is installed in `~/.claude` (not in this repo). These rules govern every
task in a project that has a loop workspace; the full text follows below this digest. Read it
before a non-trivial task.

- **Offer the `/goal` first.** When the user describes a non-trivial task, first ask whether
  they want the `/goal` (or `/loop`) prompt written (`/write-goal`). A `/goal` has a one-line
  task, 3–5 measurable success criteria, constraints, checkpoint rules, a self-verify
  instruction and a max-budget guard.
- **Critic-led development.** Non-trivial features, bug fixes, UI and E2E work go through
  `/multi-agent-dev`. Critic rounds are deterministic Workflow scripts from the kit (`critic-panel`,
  `scan-docs`, `gap-analysis`, `e2e-design`, `loop-iteration`). They are never one context
  role-playing critics.
- **Typed verdicts, recorded.** Every checker returns `accept`/`qualify`/`revise`/`defer`/`reject`.
  A missing verdict is `defer`. No durable state change (loop node done, wiki fact, story
  status) without an `accept`/`qualify` TRACE-lite record written with `loop-setup`. The store is
  never hand-edited.
- **Maker/checker.** The pass that verifies a fix is never the pass that made it.
- **Done means evidence.** A task is complete only when:
  - the flow works on localhost, with no blocking console errors and explained network failures;
  - E2E, typecheck, lint, unit and build pass where relevant;
  - the post-implementation critic round has no failed lens and no confirmed, deferred or revised blocker;
  - its TRACE records are appended (`loop-setup lint` passes);
  - changed files and remaining risks are reported.
- **Scope control.** Fix blockers and goal-related important findings only. No unrelated
  refactors, no nice-to-haves unless approved.
- **Memory.** The wiki lives in `.claude/loop-workspace/`. Open only the topic pages a task
  needs, and run `/dream` at the end of a non-trivial task.
- **Persist the state.** Run **`loop-setup sync`** before a session ends. It pushes the
  workspace to the `claude/loop-state` branch, and in a cloud session anything unsynced is lost
  with the machine.
- **Loops are hardened.**
  - Declare a trust level (L1 report-only, L2 assisted, L3 unattended).
  - Every L2/L3 action traces to a ready node of `.claude/loop-workspace/loop-plan.md`.
  - Append to `loop-run-log.md` each iteration.
  - Respect the denylist and escalation triggers.
  - Satisfy the kit's loop checklist before raising the level. L3 needs the sandbox on
    (`loop-setup l3-check`); sandbox-off L2 has no local tamper resistance.
  - Run the standing loop as `/loop 30m /loop-tick`.
- **Reporting.**
  - After a critic round, use the table `| Critic | Severity | Verdict | Finding | Evidence | Recommended action |`.
  - At the end, report goal status, browser verification, tests run (each command with its observed exit
    status and summary line), the critic summary, files changed, remaining risks and the suggested next task.
<!-- digest:end -->

## Durable project memory (LLM wiki)
Durable project knowledge is a small **knowledge wiki** in the project's loop workspace,
reached as `.claude/loop-workspace/` (a git-ignored link to
`~/.claude/loop-setup/workspaces/<id>/`; Karpathy "LLM wiki" pattern). Only the lightweight
catalog (`index.md`'s topic rows) is injected into every session by the kit's SessionStart
hook, while detailed pages stay out of context until needed.

At the start of a non-trivial task, consult that catalog and **open only the topic
page(s)** under `.claude/loop-workspace/topics/` relevant to the task (the "query"
operation). Do not load the whole wiki. This keeps per-session context flat as
memory grows.

## Self-learning loop (`/dream`)
At the end of a non-trivial task, run `/dream` to maintain the wiki:
- **ingest** — file new durable learnings into the right topic page, add a row to
  `.claude/loop-workspace/index.md` if a page is created, and append to
  `.claude/loop-workspace/log.md`;
- **lint** — health-check for contradictions, stale claims, and orphan pages.

`/dream` is a command of the loop-setup kit (`{{KIT}}/commands/dream.md`), not a
built-in Claude Code feature — it implements memory consolidation on top of Claude
Code's real memory system. Rules: only durable, verifiable facts; never secrets or
temporary/branch-specific bugs; prefer appending; confirm before removing entries.
Use the built-in `/memory` command to view or edit loaded memory files.

## Commands (skills) index
The kit's slash commands are installed at user scope (`~/.claude/commands/`, from the kit's
`commands/`) and each carries a
`description` used for routing. For the grouped "when to use which command" guide,
see `{{KIT}}/skills-index.md` (a plain catalog, kept in sync by `/dream`). Consult
it when unsure which command fits the task.

## Writing `/goal` and `/loop` prompts
Let the agent write its own `/goal`/`/loop` — Claude knows this project's
capabilities and gates better than a hand-written prompt does.

**Power move (do this every time):** when the user describes a non-trivial task,
**first ask whether they want you to write the `/goal` (or `/loop`) prompt before
starting.** If yes, produce it; don't silently start executing. The `/write-goal`
command does this on demand.

**Every `/goal` you author must include all six:**
1. A clear **one-line task statement**.
2. **3–5 measurable success criteria** (objectively checkable, tied to this repo's
   gates: the `verify` chain, no blocking console errors, E2E coverage, no
   post-implementation critic blockers).
3. **Constraints** that must hold throughout (scope limits, "don't touch X", no
   unrelated refactors, don't weaken tests).
4. **Checkpoint rules** — when to pause for review vs. run straight through.
5. A **self-verify instruction** (run the relevant checks + a post-implementation
   critic round and report evidence before claiming done).
6. A **max-budget guard** (e.g. "stop after N turns if not achieved").

**Three ways to get there:** (a) describe the outcome and ask for the `/goal`;
(b) outline the plan inline first (steps + files touched), then convert it into a
`/goal`; (c) context-dump
(`CLAUDE.md`, the memory wiki, the docs story map) and ask which `/goal`s are worth
building. Triggers: "write me the `/goal` for this", "turn this into a `/loop`",
"what `/goal` should we build based on how this project works?".

For recurring/watchdog work, the standing loop prompt is `{{KIT}}/loop.md`
(used by `/loop`). Loops are **hardened** ("loop engineering"): declare a trust
level — **L1 report-only → L2 assisted → L3 unattended** — and stay within it; read
`.claude/loop-workspace/loop-plan.md` (the durable plan/DAG — every L2/L3 action must trace to a
ready node, and re-plan runs as a first-class step before each dispatch) and
`.claude/loop-workspace/loop-run-log.md` at the start of each iteration and append an entry
per iteration; respect the denylist (auth, payments, secrets, infra, CI config, migrations),
the escalation triggers, and the red-flag stop conditions. Before raising a loop's
trust level, satisfy `{{KIT}}/loop-checklist.md`. L3 also requires the Claude Code sandbox:
`loop-setup l3-check` is not met unless the effective settings switch it on and hold
`sandbox.allowUnsandboxedCommands: false` at user scope (`loop-setup doctor` reports the state).
Sandbox-off L2 has no local tamper resistance: the loop's Bash runs as you and can rewrite the
installed kit, its manifest and the settings, which `loop-setup verify-kit` only detects afterwards.

**Maker/checker rule:** the pass that verifies a fix must be separate from the pass
that made it — the implementer never marks its own work "done" (post-implementation
critic round is the checker). For loops that mutate files in parallel, run the
implementer via `Agent` with `isolation: worktree`.

## Multi-Agent Development Workflow

Claude must use a multi-agent critic workflow for every non-trivial feature, bug fix, UI change, or E2E task.

The main Claude session acts as Lead Agent.

Before implementation, the Lead Agent must consult these critic perspectives:

1. First-Time User Critic
2. UX Flow Critic
3. Designer Critic
4. Artistic Direction Critic
5. Frontend Architecture Critic
6. QA / E2E Critic
7. Accessibility Critic
8. Performance Critic
9. Security Critic
10. Regression Critic

**Critic rounds and other fan-out work run as deterministic multi-agent Workflows,
not one agent simulating critics.** The commands invoke `Workflow`-tool scripts in
`{{KIT}}/workflows/` — parallel subagents (own context each) with adversarial /
maker-checker verification — and that command-driven invocation is the sanctioned
multi-agent opt-in:

- `critic-panel.js` — fan-out critics → adversarial verify → matrix
  (`/critic-round`, `/multi-agent-dev`, `/qa-pass`, `/loop`). Exception, measured: a
  code-only round (`uiInScope: false`) uses one reviewer covering every lens. Every blocker
  gets its own separate skeptic, and so does every important finding up to the round's
  verifier cap (`args.maxVerifiers`, default 30); any beyond the cap is recorded as
  `defer`, never dropped (TRACE-Bench F1, one run).
- `scan-docs.js` — per-story parallel evidence → separate status verifier
  (`/scan-project-docs`).
- `gap-analysis.js` — per-dimension gaps → a separate skeptic per dimension → a
  synthesized order over the licensed gaps only (`/story-gap-analysis`).
- `e2e-design.js` — per-category E2E case enumeration → dedup → a separate judge types
  each case; only licensed (accept/qualify) cases are returned for implementation
  (`/multi-agent-e2e`).
- `loop-iteration.js` — worktree implementer → separate verifier per item
  (`/loop` at L2/L3).
- `improve-skills.js` — per-lens meta-critic over the project's OWN prompts and
  workflows → adversarial verify → proposed edits (`/improve-skills`).
- `trace-bench.js` — measure our own checkers on seeded-defect fixtures (production
  loop verifier, single-pass reviewer, optional critic panel) → scored by
  `loop-setup bench-score` (`/bench-checkers`).

**Typed verdicts and records (TRACE-lite).** Every checker returns a typed verdict —
`accept` / `qualify` / `revise` / `defer` / `reject` — held to its claim type's evidence
standard, never a bare true/false; a missing verdict is `defer`. **No durable state change
without a record:** a loop node → `done`, a fact → the wiki, a story → a new status only
with an `accept`/`qualify` TRACE-lite record and a consumer action, written via
`loop-setup` (never hand-edited). Agreement between same-model critics is not evidence —
only different evidence corroborates. Policy: `{{KIT}}/rules/trace-policy.md`.

This is heavier (many subagents) by design; it buys genuine independent review
instead of one context role-playing the panel. Commands that don't fan out
(`/fix-localhost`, `/write-goal`, `/dream`, `/memory-audit`) stay single-agent.
`/bench-checkers` is the sanctioned opt-in for `trace-bench.js`.

**Self-improvement, not just self-learning.** `/dream` improves what the system
*knows* (the memory wiki); `/improve-skills` improves the *machinery* — it dogfoods
the critic panel on our own command/workflow prompts and proposes tightenings.
Both are confirmation-gated: never auto-create, rewrite, or delete a command/skill,
and never weaken an instruction or remove a safety gate as an "improvement".

## Development loop

For every task:

1. Understand the goal.
2. Inspect relevant files.
3. Start or reuse localhost.
4. Open localhost in browser using Chrome or Playwright MCP.
5. Ask each critic to review the current app/flow.
6. Produce a critic matrix:
   - critic
   - finding
   - severity: blocker / important / nice-to-have
   - evidence
   - recommended fix
7. Lead Agent decides implementation plan.
8. Implement only blocker and important issues first.
9. Run smallest relevant tests.
10. Verify the flow in browser.
11. Check browser console errors.
12. Check failed network requests.
13. Run E2E tests.
14. Run full verification when appropriate.
15. Run a second critic review after implementation.
16. Repeat until there are no blocker issues, within the fix-attempt bounds in
    Development rules. A round in which any in-scope reviewer failed is not clean, so
    re-run it; stopping on a bound is not completing.
17. Report final evidence.

## Rules

Claude must not mark a task complete only because code compiles.

A task is complete only when:

- user flow works on localhost
- browser console has no blocking errors
- failed network requests are explained or fixed
- relevant Playwright E2E tests pass
- typecheck passes
- lint passes
- unit tests pass when relevant
- build passes when relevant
- post-implementation critic review is complete (no in-scope reviewer failed; a round
  with a failed lens is re-run, never accepted as clean) and has no blockers: none
  confirmed, and none deferred or revised. An open defer/revise blocker keeps the task
  incomplete until its missing evidence is supplied and re-adjudicated, or the user
  explicitly accepts the risk
- the critic rounds' TRACE-lite records are appended (`loop-setup lint` passes)
- Artistic Direction Critic confirms the UI has an intentional look and feel when the task touches UI or product experience
- changed files and remaining risks are reported

## Scope control

Critics may suggest improvements, but the Lead Agent must classify them.

Only fix:
- blockers
- important issues directly related to the goal

Do not fix:
- unrelated refactors
- visual redesigns outside the task
- speculative architecture changes
- nice-to-have issues unless explicitly approved

## Output format after every critic round

Use this table (Verdict = the skeptic's typed TRACE verdict; show a `qualify` with its
qualifier, and list `deferred` findings with their missing evidence below the table):

| Critic | Severity | Verdict | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|

## Final response format

At the end, report:

1. Goal status
2. Browser verification
3. Tests run: each command with the result you observed in full this session (its
   exit status and the runner's own summary line). Never report a number from memory,
   from output cut by `| head`/`| tail` (a pipe hides the exit status), or from a
   subagent's report.
4. Critic review summary
5. Files changed
6. Remaining risks
7. Suggested next task

## Multi-Agent Project Documentation Scanner Workflow

Claude must keep product documentation, user stories, implementation status, and E2E coverage synchronized.

For documentation scanning tasks, Claude acts as Lead Agent: Product Delivery Auditor.

Before marking any story status, Claude must consult these perspectives:

1. Product Requirements Critic
2. User Story Critic
3. Acceptance Criteria Critic
4. Code Evidence Critic
5. Unit Test Evidence Critic
6. E2E Test Evidence Critic
7. UX / First-Time User Critic
8. Designer Critic
9. Artistic Direction Critic
10. Regression Critic
11. Documentation Consistency Critic

Claude must create or update:

- `docs/product-docs-index.md`
- `docs/stories/US-<id>-<slug>.md` — **one file per story** (the full record; copy `docs/stories/_TEMPLATE.md`)
- `docs/user-stories.md` — the story index (one row per story → its file)
- `docs/implementation-status.md` — the evidence dashboard
- `docs/e2e-coverage-map.md`
- `docs/story-verification-log.md`
- `docs/gaps-and-risks.md`

Story statuses must be evidence-based:

- `Not started`
- `Partially implemented`
- `Implemented`
- `Unit tested`
- `E2E tested`
- `Browser verified`
- `Done`
- `Blocked`
- `Deprecated`

A story may be marked `Done` only when:

1. Acceptance criteria are satisfied by implementation evidence.
2. Relevant automated tests pass.
3. E2E/browser coverage exists for the main user flow.
4. Browser verification on localhost passed, where applicable.
5. Post-scan critic review has no blockers.
6. Evidence is recorded in `docs/story-verification-log.md`.

Claude must not mark a story `Done` based only on source code inspection.
