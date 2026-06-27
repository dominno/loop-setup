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
  memory.md                       Durable learnings, imported by CLAUDE.md (maintained by /dream)
  settings.local.json             Allowed commands for the workflow
  commands/
    multi-agent-dev.md            Full critic-led development pass
    critic-round.md               Review-only multi-agent critic round
    multi-agent-e2e.md            Critic-driven E2E test design + run
    qa-pass.md                    Pre-ship QA checklist
    fix-localhost.md              Drive localhost back to a working state
    memory-audit.md               Audit project memory vs CLAUDE.md
    dream.md                      Self-learning pass: consolidate durable learnings into memory
    scan-project-docs.md          Build the user-story / status / coverage map from docs
    sync-story-status.md          Re-sync story statuses with code and tests
    story-gap-analysis.md         Gap analysis: docs vs code vs E2E
docs/
  prd.md                          Product requirements (source of record for stories)
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

## Self-learning (`/dream`)

The project "self-learns" by consolidating durable knowledge into memory so future
sessions start smarter. This uses Claude Code's **real** memory system:

- `.claude/memory.md` holds curated, durable learnings (stack, conventions,
  gotchas). It is imported into `CLAUDE.md` via `@.claude/memory.md`, so it loads
  every session.
- `/dream` (a **custom** command — see `.claude/commands/dream.md`) reviews the
  session, extracts only durable, verifiable learnings, and appends them to
  `.claude/memory.md` (proposing `CLAUDE.md` rule changes when warranted).
- The built-in `/memory` command lets you view and edit loaded memory files.

```txt
/dream            # run at the end of a task to capture what was learned
/memory-audit     # periodically prune stale or duplicated memory
```

> Note: `/dream` is **not** an official Claude Code command. It is implemented here
> as a custom slash command on top of the memory system. Hard rules: only durable,
> verifiable facts; never secrets; never temporary/branch-specific bugs; prefer
> appending; confirm before removing entries.

## Severity model

| Severity | Meaning | Action |
|---|---|---|
| Blocker | The feature should not be considered complete | Must fix |
| Important | Meaningfully affects quality, UX, maintainability, or reliability | Fix if in scope |
| Nice-to-have | Improvement, polish, or future enhancement | Record only unless approved |

## Starter app

A minimal **Next.js 16 (App Router) + TypeScript** app is included so every command
in `CLAUDE.md` runs end-to-end out of the box:

```txt
src/
  app/
    layout.tsx            Root layout + global styles
    page.tsx              Home page (hero + greeting form)
    globals.css           Dark, cohesive theme
    api/health/route.ts   Liveness endpoint (used by smoke test)
  components/
    GreetingForm.tsx      Client form with accessible error wiring
  lib/
    greeting.ts           Pure validation/greeting rule (unit-tested)
    greeting.test.ts      Vitest unit tests
e2e/
  smoke.spec.ts           Home renders + /api/health responds
  critical-flows.spec.ts  Greeting happy path, validation failure, recovery
```

The one feature (`US-001`, greet a visitor by name) is tracked through the audit
docs in `docs/` as a worked example.

### Setup

```bash
pnpm install        # Chromium is pre-provisioned in this environment
pnpm verify         # typecheck + lint + unit + build + E2E
pnpm dev            # http://localhost:3000
```

Toolchain: Next 16, React 19, TypeScript 6, ESLint 9 (flat config via
`eslint-config-next`), Vitest 4, Playwright 1.56.

### package.json scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "verify": "pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e"
  }
}
```

> Next 16 removed `next lint`, so `pnpm lint` runs ESLint directly against the
> flat config in `eslint.config.mjs`.

Swap this starter for your real stack as the project grows — the rule that matters
is: **Claude must know the exact verification commands and must not guess.** Keep
`CLAUDE.md` and `package.json` in sync.
