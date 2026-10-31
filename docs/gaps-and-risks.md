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
- **US-001/US-002 — a failed storage write loses the greeting** (2026-10-31 live runs; reproduced on localhost). When `localStorage` writes throw (storage full, or blocked in some private modes), a valid submit shows no greeting and no error, and empties the field: `saveRememberedName` swallows the error without notifying, and `GreetingForm` shows a greeting only for the stored name. Reproduced: field `''`, greeting count 0, `#name-error` count 0, no `pageerror`. No test covers a `setItem` that throws (the unit tests cover only an absent `localStorage`).
- **US-002 AC5 intent (privacy) — without JavaScript the name goes into the URL** (2026-10-31 live runs; reproduced on localhost). With JavaScript off, or before hydration, "Say hello" submits the form natively as `GET /?name=<the name>`, so the name lands in the URL, the browser history and the server's request line, and no greeting shows. Reproduced with `javaScriptEnabled: false`. The AC5 E2E case runs with JavaScript on and flags only requests that leave `http://localhost:3000`, so it cannot see this one.

## Functional but failing UX / design / artistic-direction review
- US-001 passed its earlier UX / design review (richer motion/illustration is an optional nice-to-have); the 2026-10-31 live runs found the two issues below.
- **US-002 accessibility — keyboard focus is lost after "Not you? Clear"** (2026-10-31 live runs; reproduced on localhost). Activating the control from the keyboard removes it while it holds focus, so focus drops to `<body>` and the next keystrokes are lost (reproduced: `document.activeElement` is `BODY`, and typed text never reaches the field). The keyboard case in `e2e/a11y.spec.ts` covers only the greeting happy path.
- **US-001 layout — a long unbroken name overflows the card** (2026-10-31 live runs; reproduced on localhost). A 40-character name with no spaces, the longest the form accepts, overflows the card at a 375 px viewport (scrollWidth 683 > 375).

## Ambiguous or contradictory requirements
- `docs/prd.md` is now the source of record. US-002 AC2 (auto-show greeting on load) interacts with US-001's empty-state; the Regression Critic flagged it as a behavior to preserve, not a contradiction.
- **The PRD contradicts the story map on US-002** (2026-10-31 live runs). `docs/prd.md` still heads section 5.2 (US-002) "Remember me on return (not yet implemented)", although US-002 is implemented and `E2E tested` (`docs/stories/US-002-remember-me.md`). The PRD heading needs updating by its owner.
- **Open product decisions** (deferred by the e2e-design judge in the 2026-10-31 `/multi-agent-e2e` remember-me run): what the 40-character limit (PRD 5.1 AC3) counts — UTF-16 code units, code points or graphemes — and whether a name made only of invisible characters (zero-width spaces or joiners) counts as empty (PRD 5.1 AC2). Today `src/lib/greeting.ts` counts UTF-16 code units (`name.length`; nine 5-unit ZWJ emoji, 9 graphemes but 45 units, are rejected) and accepts a zero-width-only name, which `trim()` and `\s` do not remove.

## Blocked in current environment
- Manual MCP browser verification of US-001 is **blocked here**: no Playwright/Chrome MCP server is configured and this is a headless remote container. Automated Playwright (Chromium) is the available browser-verification path and is green (7/7). Promote US-001 to `Done` from an interactive session with the MCP browser, or relax the "manual MCP" requirement to "automated E2E on Chromium" for headless runs.

## Recommended next implementation order
1. ~~Add an E2E case for the US-001 max-length boundary.~~ **Done 2026-06-27.**
2. Promote US-001 to `Done`: run manual Chrome/Playwright MCP verification + a post-implementation critic round from an interactive session (blocked in headless env — see above).
3. ~~Add a real PRD under `docs/` and re-run `/scan-project-docs`.~~ **Done 2026-06-27** — `docs/prd.md` added; scan extracted US-002.
4. ~~Implement US-002 (Remember me on return) with unit + E2E coverage, then run critic rounds.~~ **Done 2026-06-27** — implemented, 13 unit + 11 E2E green, post-implementation critics clean. Remaining: manual MCP browser verification to reach `Done`.

Items 5–9 come from the 2026-10-31 live runs of `/multi-agent-e2e` (the remember-me flow) and `/story-gap-analysis` ("MVP readiness"). The Lead reproduced items 5–8 on localhost with headless Chromium probes; item 9 is a docs and product decision. No story status changed.

5. **Storage-full greeting (US-001/US-002):** show the greeting for a valid submit even when the storage write fails, and add a unit and an E2E case with a throwing `setItem`.
6. **No-JS name leak (US-002 AC5 intent):** make a submit without JavaScript (or before hydration) send no name to the server, since AC5 says no personal data leaves the browser, and add an E2E case with JavaScript disabled.
7. **Keyboard Clear focus (US-002):** after "Not you? Clear", move focus to the name field, and add a keyboard E2E case for it.
8. **Narrow-viewport overflow (US-001):** wrap a 40-character unbroken name inside the card at 375 px, and add a narrow-viewport check.
9. **PRD and limit decisions:** update PRD 5.2's "(not yet implemented)" heading; decide what the 40-character limit counts and whether invisible-only names are empty, then pin both decisions in unit and E2E cases.
