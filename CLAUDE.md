# Project Instructions for Claude Code

## Durable project memory (LLM wiki)
Durable project knowledge is a small **knowledge wiki** under `.claude/memory/`
(Karpathy "LLM wiki" pattern). Only the lightweight catalog is imported here, so it
loads every session while detailed pages stay out of context until needed:

@.claude/memory/index.md

At the start of a non-trivial task, consult that index and **open only the topic
page(s)** under `.claude/memory/topics/` relevant to the task (the "query"
operation). Do not load the whole wiki. This keeps per-session context flat as
memory grows.

## Self-learning loop (`/dream`)
At the end of a non-trivial task, run `/dream` to maintain the wiki:
- **ingest** — file new durable learnings into the right topic page, add a row to
  `.claude/memory/index.md` if a page is created, and append to
  `.claude/memory/log.md`;
- **lint** — health-check for contradictions, stale claims, and orphan pages.

`/dream` is a custom command in this repo (`.claude/commands/dream.md`), not a
built-in Claude Code feature — it implements memory consolidation on top of Claude
Code's real memory system. Rules: only durable, verifiable facts; never secrets or
temporary/branch-specific bugs; prefer appending; confirm before removing entries.
Use the built-in `/memory` command to view or edit loaded memory files.

## Commands (skills) index
The custom slash commands live in `.claude/commands/` and each carries a
`description` used for routing. For the grouped "when to use which command" guide,
see `.claude/skills-index.md` (a plain catalog, kept in sync by `/dream`). Consult
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
(b) `/plan` first, then convert the plan into a `/goal`; (c) context-dump
(`CLAUDE.md`, the memory wiki, the docs story map) and ask which `/goal`s are worth
building. Triggers: "write me the `/goal` for this", "turn this into a `/loop`",
"what `/goal` should we build based on how this project works?".

For recurring/watchdog work, the standing loop prompt is `.claude/loop.md`
(used by `/loop`).

## Project type
This is a local web application developed and tested on localhost.

## Package manager
Use pnpm unless package-lock.json exists. Do not switch package managers.

## Main commands
- Start dev server: `pnpm dev`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Unit tests: `pnpm test`
- E2E tests: `pnpm test:e2e`
- Production build: `pnpm build`
- Full verification: `pnpm verify`

## Localhost
Default app URL: `http://localhost:3000`.

Before browser testing:
1. Check if the dev server is already running.
2. If not running, start it in the background.
3. Wait until localhost responds.
4. Only then use Chrome or Playwright MCP.

## Development rules
- Follow SOLID, DRY, KISS, and TDD.
- Prefer small, focused changes.
- Do not rewrite large unrelated areas.
- Do not change public APIs unless the task explicitly requires it.
- Do not hide failing tests.
- Do not delete tests to make the suite pass.
- Always explain root cause before applying a fix.
- After fixing, run the smallest relevant test first, then the full verification command.

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
16. Repeat until there are no blocker issues.
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
- post-implementation critic review has no blockers
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

Use this table:

| Critic | Severity | Finding | Evidence | Recommended action |
|---|---|---|---|---|

## Final response format

At the end, report:

1. Goal status
2. Browser verification
3. Tests run
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
- `docs/user-stories.md`
- `docs/implementation-status.md`
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
