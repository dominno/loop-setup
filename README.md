# Claude Code Multi-Agent Localhost Loop Setup

This repository is configured for the **Claude Code multi-agent critic workflow** —
a way of using Claude Code as a **Lead Agent** that coordinates specialist critics to
develop and end-to-end test a local web app on `localhost`, instead of letting it work
as a single coding agent that just edits files.

The workflow starts with critique, not coding — and ends with proof, not confidence.

> **Adopting this in your own project?** See the
> **[Adoption Guide](docs/adoption-guide.md)** — what to copy, how to wire the
> verification commands, and how to adapt the memory wiki and story map (covers
> both a fresh start and dropping the workflow into an existing codebase).

## What's in this setup

```txt
CLAUDE.md                         Project rules + multi-agent workflow + doc-scanner workflow
.claude/
  loop.md                         Recurring multi-agent watchdog loop (used by /loop)
  skills-index.md                 Grouped "when to use which command" catalog (kept in sync by /dream)
  memory/                         Knowledge wiki (Karpathy LLM-wiki pattern), maintained by /dream
    index.md                      Small catalog imported by CLAUDE.md (always loaded)
    log.md                        Append-only history of wiki operations
    topics/                       One page per subject, read on demand
  settings.local.json             Allowed commands for the workflow
  commands/                       Each command has a description used for routing
    write-goal.md                 Write a production-grade /goal (or /loop) prompt for a task
    multi-agent-dev.md            Full critic-led development pass
    critic-round.md               Review-only multi-agent critic round
    multi-agent-e2e.md            Critic-driven E2E test design + run
    qa-pass.md                    Pre-ship QA checklist
    fix-localhost.md              Drive localhost back to a working state
    memory-audit.md               Audit project memory vs CLAUDE.md
    dream.md                      Self-learning pass: ingest learnings, lint, propose skills
    scan-project-docs.md          Build the user-story / status / coverage map from docs
    sync-story-status.md          Re-sync story statuses with code and tests
    story-gap-analysis.md         Gap analysis: docs vs code vs E2E
docs/
  adoption-guide.md               How to adopt this template in a real project
  prd.md                          Product requirements (source of record for stories)
  product-docs-index.md           Source documents scanned
  user-stories.md                 Living backlog of user stories
  implementation-status.md        Story → implementation/test/verification status
  e2e-coverage-map.md             Story → Playwright/browser coverage
  story-verification-log.md       Evidence log of checks actually run
  gaps-and-risks.md               Missing/untested/contradictory areas
```

**Which command when?** Each command above carries a one-line description; the full
grouped *"when to use which"* catalog (with a pick-by-intent guide) is
[`.claude/skills-index.md`](.claude/skills-index.md).

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

Let Claude write the `/goal` for you — it knows the project's gates better than a
hand-written prompt. `CLAUDE.md` also tells Claude to *offer* this whenever you
describe a non-trivial task.

```txt
# Start a task — pick ONE entry point:
/write-goal add password reset        # Claude writes a production-grade /goal → review, then run IT
/multi-agent-dev implement [FEATURE]  # — or — drive the critic loop directly, no /goal
/goal [FEATURE] is complete using the multi-agent critic workflow, verified on
      localhost, covered by E2E tests, with no post-implementation critic blockers.
      Stop after 25 turns if not achieved.   # — or — hand-write the /goal yourself

# Then, before committing:
/qa-pass final pre-commit check
```

These three are **alternatives**, not a sequence — if you used `/write-goal`, run
the `/goal` it produced (don't skip to `/multi-agent-dev`).

Every `/goal` should carry six things: a one-line task statement, 3–5 measurable
success criteria, constraints, checkpoint rules, a self-verify instruction, and a
max-budget guard. `/write-goal` produces all six, grounded in this repo.

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

## Self-learning (`/dream`) — an LLM wiki

The project "self-learns" by consolidating durable knowledge into a small
**knowledge wiki**, so future sessions start smarter without bloating context.
This follows Andrej Karpathy's [LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
and uses Claude Code's **real** memory system (`@import` + `/memory`):

```txt
.claude/memory/
  index.md        small catalog: each topic = one-line summary + link (always loaded)
  log.md          append-only history of ingest / lint operations
  topics/         one page per subject — read ON DEMAND, not all at once
    tooling.md  build-and-verify.md  testing.md  client-react.md
    code-organization.md  remote-env.md  workflow.md
```

- **Why a wiki, not one file:** `CLAUDE.md` imports only `index.md`, so per-session
  context stays flat as knowledge grows. Claude opens just the topic page(s)
  relevant to the task (the *query* operation) instead of loading everything.
- **`/dream`** (a **custom** command — see `.claude/commands/dream.md`) is the
  wiki maintainer: *ingest* files new durable learnings into the right topic page
  and appends to `log.md`; *lint* health-checks for contradictions, stale claims,
  and orphan pages. Run it at the end of a non-trivial task.
- The built-in **`/memory`** command lets you view and edit loaded memory files.

```txt
/dream            # ingest what was learned this task into the wiki
/dream lint       # health-check the wiki (contradictions, stale, orphans)
/dream query how do we test localStorage?   # answer from the wiki, with citations
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
    GreetingForm.tsx      Client form: greeting, persistence, Clear control
  lib/
    greeting.ts           Pure validation/greeting rule (unit-tested)
    greeting.test.ts      Vitest unit tests
    rememberedName.ts     Safe localStorage wrapper + change subscription
    rememberedName.test.ts Vitest unit tests (incl. storage-unavailable path)
e2e/
  smoke.spec.ts           Home renders + /api/health responds
  critical-flows.spec.ts  Greeting happy path, validation, boundaries, recovery
  remember-me.spec.ts     Reload persistence, clear, no-persist-on-failure, no-network
```

Two features are tracked through the audit docs in `docs/` as worked examples:
`US-001` (greet a visitor by name) and `US-002` (remember me on return).

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
