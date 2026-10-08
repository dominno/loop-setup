---
description: Re-sync existing user-story statuses with current code and tests and record evidence (adds no new requirements). Use after implementing/testing stories to refresh statuses.
argument-hint: [scope, e.g. "current branch"]
---

Synchronize user story status with current implementation and tests.

Scope:
$ARGUMENTS

Procedure:

1. Read `docs/user-stories.md` (the index), then open only the per-story files
   under `docs/stories/` that are in scope. Also consult the memory wiki
   (`.claude/memory/index.md` → relevant topic pages such as `topics/testing.md`)
   so evidence judgments match the project's testing/verification conventions.
2. Read `docs/implementation-status.md` if it exists.
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
   stories) so a separate status verifier issues the verdicts, then apply them exactly as
   `/scan-project-docs` step 9 does (accept → COMMIT, qualify → COMMIT_QUALIFIED at the
   lower status, revise/defer → status unchanged + HOLD; Lead-raised `Browser verified`/
   `Done` only with its own record citing the browser observation and a no-blocker critic
   round). No status change without a licensing record (`.claude/memory/topics/trace.md`).
10. Update `docs/e2e-coverage-map.md`.
11. Update `docs/gaps-and-risks.md`.

Rules:

- Do not create new product requirements unless they are found in docs.
- Do not mark `Done` without evidence.
- Mark as `Partially implemented` when code exists but acceptance criteria are incomplete.
- Mark as `Implemented` when code exists but test/browser evidence is missing.
- Mark as `E2E tested` only when a real E2E test covers the story.
- Mark as `Browser verified` only when Claude actually verified localhost in browser.
- Mark as `Done` only when all completion rules are satisfied.
