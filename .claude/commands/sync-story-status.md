---
description: Re-sync existing user-story statuses with current code and tests and record evidence (adds no new requirements). Use after implementing/testing stories to refresh statuses.
argument-hint: [scope, e.g. "current branch"]
---

Synchronize user story status with current implementation and tests.

Scope:
$ARGUMENTS

Procedure:

1. Read `docs/user-stories.md`. Also consult the memory wiki
   (`.claude/memory/index.md` → relevant topic pages such as `topics/testing.md`)
   so evidence judgments match the project's testing/verification conventions.
2. Read `docs/implementation-status.md` if it exists.
3. Inspect relevant source files.
4. Inspect relevant unit/component tests.
5. Inspect relevant E2E tests.
6. Start or reuse localhost when browser verification is needed.
7. Verify implemented flows in browser when possible.
8. Update story statuses using the strict status model.
9. Record evidence in `docs/story-verification-log.md`.
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
