Analyze the gap between product documentation, implemented code, and E2E tests.

Scope:
$ARGUMENTS

Before analyzing, consult the memory wiki: read `.claude/memory/index.md` and open
the topic pages relevant to the gaps you're assessing (e.g. `topics/testing.md`,
`topics/build-and-verify.md`) so "tested / not tested" and "edge cases" judgments
reflect the project's real conventions.

Produce:

1. Requirements found in docs but not implemented.
2. Implemented features not described in docs.
3. Stories implemented but not unit-tested.
4. Stories implemented but not E2E-tested.
5. Stories E2E-tested but missing important edge cases.
6. Stories that work functionally but fail UX/design/artistic direction review.
7. Ambiguous or contradictory requirements.
8. Recommended next implementation order.

Use critic agents:

- Product Requirements Critic
- Code Evidence Critic
- Unit Test Evidence Critic
- E2E Test Evidence Critic
- UX / First-Time User Critic
- Designer Critic
- Artistic Direction Critic
- Regression Critic
- Documentation Consistency Critic

Do not edit files unless explicitly asked.
