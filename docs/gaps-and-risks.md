# Gaps and Risks

Tracks missing requirements, unclear docs, untested areas, and contradictions
found during documentation/story synchronization.

## Requirements in docs but not implemented
- _none_ — US-002 (Remember me on return) is now implemented and `E2E tested` (`src/lib/rememberedName.ts`, `e2e/remember-me.spec.ts`).

## Implemented features not described in docs
- _none recorded yet_

## Implemented but not unit-tested
- _none recorded yet_

## Implemented but not E2E-tested
- _none recorded yet_

## E2E-tested but missing important edge cases
- ~~US-001: the 40-character max-length boundary is covered by unit tests only, not by an E2E test.~~ **Closed 2026-06-27** — added two E2E cases in `e2e/critical-flows.spec.ts` (41 chars rejected, 40 chars accepted). Suite now 7/7.

## Functional but failing UX / design / artistic-direction review
- _none recorded yet_ (US-001 passes; richer motion/illustration is an optional nice-to-have)

## Ambiguous or contradictory requirements
- _none currently_ — `docs/prd.md` is now the source of record. US-002 AC2 (auto-show greeting on load) interacts with US-001's empty-state; the Regression Critic flagged it as a behavior to preserve, not a contradiction.

## Blocked in current environment
- Manual MCP browser verification of US-001 is **blocked here**: no Playwright/Chrome MCP server is configured and this is a headless remote container. Automated Playwright (Chromium) is the available browser-verification path and is green (7/7). Promote US-001 to `Done` from an interactive session with the MCP browser, or relax the "manual MCP" requirement to "automated E2E on Chromium" for headless runs.

## Recommended next implementation order
1. ~~Add an E2E case for the US-001 max-length boundary.~~ **Done 2026-06-27.**
2. Promote US-001 to `Done`: run manual Chrome/Playwright MCP verification + a post-implementation critic round from an interactive session (blocked in headless env — see above).
3. ~~Add a real PRD under `docs/` and re-run `/scan-project-docs`.~~ **Done 2026-06-27** — `docs/prd.md` added; scan extracted US-002.
4. ~~Implement US-002 (Remember me on return) with unit + E2E coverage, then run critic rounds.~~ **Done 2026-06-27** — implemented, 13 unit + 11 E2E green, post-implementation critics clean. Remaining: manual MCP browser verification to reach `Done`.
