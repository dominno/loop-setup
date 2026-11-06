---
description: Re-sync existing user-story statuses with current code and tests and record evidence (adds no new requirements). Use after implementing/testing stories to refresh statuses.
argument-hint: [scope, e.g. "current branch"]
---

Synchronize user story status with current implementation and tests.

Scope:
$ARGUMENTS

Procedure:

1. **Stale evidence first:** run `pnpm trace reaudit --claim-prefix story:` — the story-status
   records whose cited evidence changed since their commit (or whose commit is unreachable).
   Re-verify those stories before any other; the list never downgrades a status by itself — a
   new scan-docs record is still the only way a story's status changes.
   Then read `docs/user-stories.md` (the index), then open only the per-story files
   under `docs/stories/` that are in scope. Also consult the memory wiki
   (`.claude/memory/index.md` → relevant topic pages such as `topics/testing.md`)
   so evidence judgments match the project's testing/verification conventions.
2. Read `docs/implementation-status.md` if it exists. `pnpm trace story-lint` lists each
   story's open loop-plan nodes (`[plan-nodes]`, from a node's `story:US-NNN#ACk` origin
   token; `pnpm trace plan-ready --json` carries the same links): an open node is context,
   never evidence — a plan node never moves a story's status, and a status never moves a node.
3. Inspect relevant source files.
4. Inspect relevant unit/component tests.
5. Inspect relevant E2E tests.
6. Start or reuse localhost when browser verification is needed.
7. Verify implemented flows in browser when possible.
8. Work out each in-scope story's **proposed** status with the strict status model — do
   not write it yet; step 9's separate verifier decides what may be written. After step
   9, update each story's own `docs/stories/US-*.md` file with the status its verdict
   licenses, and reflect it in the `docs/user-stories.md` index table and the
   `docs/implementation-status.md` dashboard row.
9. Record evidence in `docs/story-verification-log.md`. The status itself must not be
   self-adjudicated (maker ≠ checker): run the **scan-docs Workflow** for the in-scope
   stories (`scriptPath: .claude/workflows/scan-docs.js`, `args.stories` = those
   stories, at most `maxStories` per call — default 30, two agents each; batch a longer
   list, since a larger batch is refused with `error` before any agent starts) so a
   separate status verifier issues the verdicts, then apply them exactly as
   `/scan-project-docs` step 9 does (an `error` → no status changes and no records: re-run
   it; accept → COMMIT, qualify → COMMIT_QUALIFIED at the lower status, revise/defer →
   status unchanged + HOLD; Lead-raised `Browser verified`/`Done` only with its own record
   — claim_text `Story <id> (<title>) is at status "<S>"`, the form scan-docs writes —
   citing the browser observation (a `browser` item) and a critic round whose
   `completion.verdict` is `accept` (its records as `record` items), that completion cited
   in its evidence; `pnpm trace story-lint` checks that each cited record licenses exactly
   the story's status with that level's evidence kinds). That critic round runs as
   `/scan-project-docs` step 15 says: when UI or perf lenses are in scope, first run
   `pnpm test:e2e` (including `e2e/a11y.spec.ts`) and `pnpm build && pnpm check:bundle`
   yourself and pass their output as `priorEvidence` (the critics and skeptics never run
   E2E, and never build or test in the shared checkout). No status change without a
   licensing record (`.claude/memory/topics/trace.md`).
10. Update `docs/e2e-coverage-map.md`.
11. Update `docs/gaps-and-risks.md`.
12. **Last**, after steps 8-11 (step 8's status writes, which wait for step 9's verdicts;
    step 9's verification-log rows; step 10's coverage map; step 11's gaps file), run
    `pnpm -s trace story-lint` and handle it as `/scan-project-docs` step 19 says: it must
    exit 0; fix the projections (the index, the dashboard) to match each story file's
    recorded status, add a log or coverage row only for a check that was actually run, and
    never change a status to satisfy the lint without a licensing record.

Rules:

- Do not create new product requirements unless they are found in docs.
- Do not mark `Done` without evidence.
- Mark as `Partially implemented` when code exists but acceptance criteria are incomplete.
- Mark as `Implemented` when code exists but test/browser evidence is missing.
- Mark as `E2E tested` only when a real E2E test covers the story.
- Mark as `Browser verified` only when Claude actually verified localhost in browser.
- Mark as `Done` only when all completion rules are satisfied.
