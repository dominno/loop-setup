# Implementation Status

Maps each user story to implementation, tests, and verification status.
Statuses are evidence-based and must not be marked `Done` from source inspection alone.

| Story ID | Story | Source doc | Implementation | Unit tests | E2E tests | Browser verified | Final status | Evidence | Next action |
|---|---|---|---|---|---|---|---|---|---|
| _none yet_ | — | — | — | — | — | — | — | — | — |

## Status model

| Status | Meaning |
|---|---|
| `Not started` | Requirement exists in docs, but no implementation evidence was found |
| `Partially implemented` | Some code exists, but acceptance criteria are incomplete |
| `Implemented` | Code appears to satisfy the acceptance criteria |
| `Unit tested` | Unit/component tests cover the core logic |
| `E2E tested` | Playwright or browser E2E test covers the user flow |
| `Browser verified` | Claude manually verified the flow on localhost using Chrome or Playwright MCP |
| `Done` | Implemented + relevant tests pass + E2E/browser verification exists + no blocker critics remain |
| `Blocked` | Requirement cannot be completed because of missing docs, missing dependency, bug, or design ambiguity |
| `Deprecated` | Requirement exists in old docs but should no longer be implemented |
