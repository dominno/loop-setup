# E2E Coverage Map

Maps each user story to Playwright/browser coverage.

| Story ID | User flow | E2E test file | Happy path | Failure path | Edge cases | Last verified | Gap |
|---|---|---|---|---|---|---|---|
| US-001 | Greeting form | `e2e/critical-flows.spec.ts` | Yes | Yes (empty name) | Yes (recovery; 41-char rejected; 40-char accepted) | 2026-06-27 | None |
| US-001 | App smoke / health | `e2e/smoke.spec.ts` | Yes | — | — | 2026-06-27 | None |
| US-002 | Remember me on return | `e2e/remember-me.spec.ts` | Yes (reload AC1/AC2) | Yes (no-persist on invalid AC4) | Yes (clear AC3; no-network AC5) | 2026-06-27 | None |

## Rules

- Mark a path `Yes` only when an E2E test asserts a visible outcome, not just page load.
- Every story with a user-facing flow should eventually have at least a happy path and one failure path.
- Record the date in `Last verified` when a test is actually run or the flow is browser-verified.
