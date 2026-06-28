# US-002: Remember me on return

**Source:** `docs/prd.md` section 5.2 "Remember me on return"

**User story:**
As a returning visitor, I want the app to remember my name in my browser, so that
I don't have to retype it on every visit.

**Acceptance criteria:**
- [x] AC1: After a successful greeting, the name is persisted to `localStorage`.
- [x] AC2: On reload, the input is pre-filled with the remembered name and that
      greeting is shown automatically.
- [x] AC3: A visible "Not you? Clear" control removes the remembered name and
      resets the form.
- [x] AC4: Nothing is persisted when validation fails.
- [x] AC5: No personal data leaves the browser (localStorage only).

**Implementation evidence:**
- Status: Implemented
- Files:
  - `src/lib/rememberedName.ts` (safe localStorage wrapper + change subscription)
  - `src/components/GreetingForm.tsx` (reads the store via `useSyncExternalStore`;
    persists on success, clears on demand)
  - `src/app/globals.css` (`.button-ghost` for the Clear control)
- Notes: Storage access is isolated in `src/lib/rememberedName.ts`; the pure
  `src/lib/greeting.ts` rule stays DOM-free. The store is read with
  `useSyncExternalStore` (server snapshot `null`) to avoid an SSR/hydration
  mismatch without a setState-in-effect.

**Test evidence:**
- Unit/component tests: Present — `src/lib/rememberedName.test.ts` (6 cases:
  save/load/clear, empty value, and the storage-unavailable path)
- E2E tests: Present — `e2e/remember-me.spec.ts` (AC1/AC2 reload, AC3 clear,
  AC4 no-persist-on-failure, AC5 no external network)
- Browser verified: Automated only (Playwright/Chromium); manual MCP not run
- Evidence: see `docs/story-verification-log.md` (`pnpm verify` green 2026-06-27)

**Critic status:**
- Product Requirements Critic: pass (story matches PRD 5.2)
- Acceptance Criteria Critic: pass (AC1–AC5 concrete and tested, incl. negative AC4)
- Code Evidence Critic: pass — implementation present and isolated
- QA / E2E Critic: pass — reload, clear, negative, and network cases covered
- Regression Critic: pass — US-001 suite (5 E2E) still green
- Security Critic: pass — localStorage only; AC5 asserts no external requests

**Final status:**
E2E tested

**Next action:**
Manual MCP browser verification + a recorded post-implementation critic round
from an interactive session, then promote to `Done` (blocked in headless env).
