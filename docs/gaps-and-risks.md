# Gaps and Risks

Tracks missing requirements, unclear docs, untested areas, and contradictions
found during documentation/story synchronization.

## Requirements in docs but not implemented
- _none recorded yet_

## Implemented features not described in docs
- _none recorded yet_

## Implemented but not unit-tested
- _none recorded yet_

## Implemented but not E2E-tested
- _none recorded yet_

## E2E-tested but missing important edge cases
- US-001: the 40-character max-length boundary is covered by unit tests only, not by an E2E test.

## Functional but failing UX / design / artistic-direction review
- _none recorded yet_ (US-001 passes; richer motion/illustration is an optional nice-to-have)

## Ambiguous or contradictory requirements
- No formal PRD exists yet. US-001 was derived from the README and the implemented code; future stories should be backed by a real product doc.

## Recommended next implementation order
1. Manually browser-verify US-001 via Chrome/Playwright MCP and run a post-implementation critic round to promote it to `Done`.
2. Add an E2E case for the US-001 max-length boundary.
3. Add a real PRD under `docs/` and re-run `/scan-project-docs` to extract further stories.
