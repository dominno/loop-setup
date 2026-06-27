# Claude Code Multi-Agent Localhost Loop Setup

This repository is configured for the **Claude Code multi-agent critic workflow** —
a way of using Claude Code as a **Lead Agent** that coordinates specialist critics to
develop and end-to-end test a local web app on `localhost`, instead of letting it work
as a single coding agent that just edits files.

The workflow starts with critique, not coding — and ends with proof, not confidence.

## What's in this setup

```txt
CLAUDE.md                         Project rules + multi-agent workflow + doc-scanner workflow
.claude/
  loop.md                         Recurring multi-agent watchdog loop (used by /loop)
  settings.local.json             Allowed commands for the workflow
  commands/
    multi-agent-dev.md            Full critic-led development pass
    critic-round.md               Review-only multi-agent critic round
    multi-agent-e2e.md            Critic-driven E2E test design + run
    qa-pass.md                    Pre-ship QA checklist
    fix-localhost.md              Drive localhost back to a working state
    memory-audit.md               Audit project memory vs CLAUDE.md
    scan-project-docs.md          Build the user-story / status / coverage map from docs
    sync-story-status.md          Re-sync story statuses with code and tests
    story-gap-analysis.md         Gap analysis: docs vs code vs E2E
docs/
  product-docs-index.md           Source documents scanned
  user-stories.md                 Living backlog of user stories
  implementation-status.md        Story → implementation/test/verification status
  e2e-coverage-map.md             Story → Playwright/browser coverage
  story-verification-log.md       Evidence log of checks actually run
  gaps-and-risks.md               Missing/untested/contradictory areas
```

## Critic roster

Pre-implementation and post-implementation critic rounds use:

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

The documentation-scanner workflow adds: Product Requirements, User Story,
Acceptance Criteria, Code Evidence, Unit Test Evidence, E2E Test Evidence, and
Documentation Consistency critics.

## Everyday workflow

```txt
/multi-agent-dev implement [FEATURE]
/goal [FEATURE] is complete using the multi-agent critic workflow, verified on
      localhost, covered by E2E tests, with no post-implementation critic blockers.
      Stop after 25 turns if not achieved.
/qa-pass final pre-commit check
```

Long-running watchdog:

```txt
/loop 10m
```

Product delivery audit:

```txt
/scan-project-docs full project
/sync-story-status current branch
/story-gap-analysis MVP readiness
```

## Severity model

| Severity | Meaning | Action |
|---|---|---|
| Blocker | The feature should not be considered complete | Must fix |
| Important | Meaningfully affects quality, UX, maintainability, or reliability | Fix if in scope |
| Nice-to-have | Improvement, polish, or future enhancement | Record only unless approved |

## Adapting to your app

This setup assumes a `pnpm` + `localhost:3000` web app. When you add the actual
application, define these scripts in `package.json` so Claude never has to guess the
verification commands:

```json
{
  "scripts": {
    "dev": "next dev",
    "typecheck": "tsc --noEmit",
    "lint": "next lint",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "build": "next build",
    "verify": "pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e"
  }
}
```

Adjust the commands in `CLAUDE.md` and `package.json` to match your real stack.
The rule that matters: **Claude must know the exact verification commands and must not guess.**
