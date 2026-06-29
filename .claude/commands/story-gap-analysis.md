---
description: Read-only analysis of gaps between docs, implemented code, and E2E tests; recommends the next implementation order. Use when assessing MVP readiness or deciding what to build/test next.
argument-hint: [scope, e.g. "MVP readiness"]
---

Analyze the gap between product documentation, implemented code, and E2E tests.

Scope:
$ARGUMENTS

Before analyzing, consult the memory wiki: read `.claude/memory/index.md` and open
the topic pages relevant to the gaps you're assessing (e.g. `topics/testing.md`,
`topics/build-and-verify.md`) so "tested / not tested" and "edge cases" judgments
reflect the project's real conventions.

**Run the analysis as a deterministic multi-agent Workflow** — invoke the Workflow
tool with `scriptPath: .claude/workflows/gap-analysis.js`,
`args: { "scope": "$ARGUMENTS" }`. One agent analyzes each gap dimension in its own
context, in parallel; a final agent synthesizes the recommended order. (Invoking
Workflow here is expected.)

The workflow returns `{ scope, totalGaps, byDimension, recommendedOrder }` covering:

1. Requirements found in docs but not implemented (`docs-not-impl`).
2. Implemented features not described in docs (`impl-not-docs`).
3. Stories implemented but not unit-tested (`impl-not-unit`).
4. Stories implemented but not E2E-tested (`impl-not-e2e`).
5. Stories E2E-tested but missing important edge cases (`e2e-missing-edges`).
6. Stories that work but fail UX/design/artistic-direction review (`ux-design`).
7. Ambiguous or contradictory requirements (`ambiguous`).
8. Recommended next implementation order (`recommendedOrder`).

Render the dimensions + the recommended order. Do not edit files unless explicitly asked.
