# User Stories

Living backlog of user stories extracted from the product documentation.
Each story uses the format below. Populate with `/scan-project-docs`.

## US-001: Greet a visitor by name

**Source:** `README.md` (starter-app description), implemented in `src/`

**User story:**
As a first-time visitor, I want to enter my name and get a personalized
greeting, so that the app feels responsive and I get immediate feedback.

**Acceptance criteria:**
- [x] AC1: Entering a valid name and submitting shows `Hello, <name>! Welcome aboard.`
- [x] AC2: Submitting an empty/whitespace name shows an inline validation error and no greeting.
- [x] AC3: Names longer than 40 characters are rejected with a clear message.
- [x] AC4: Fixing the input after an error replaces the error with a greeting (recovery).

**Implementation evidence:**
- Status: Implemented
- Files:
  - `src/lib/greeting.ts` (pure validation/greeting rule)
  - `src/components/GreetingForm.tsx` (client form, accessible error wiring)
  - `src/app/page.tsx` (home page)
  - `src/app/api/health/route.ts` (liveness endpoint)
- Notes: Validation logic is isolated in `src/lib` so it is unit-testable and reusable.

**Test evidence:**
- Unit/component tests: Present — `src/lib/greeting.test.ts` (7 cases, all passing)
- E2E tests: Present — `e2e/critical-flows.spec.ts` (happy, failure, recovery, max-length boundary ×2), `e2e/smoke.spec.ts`
- Browser verified: Automated only (Playwright/Chromium); manual MCP verification not yet run
- Evidence: see `docs/story-verification-log.md`

**Critic status:**
- Product Requirements Critic: pass
- UX / First-Time User Critic: pass (clear label, feedback on submit, recovery path)
- Designer Critic: pass (consistent form spacing, focus/error states)
- Artistic Direction Critic: nice-to-have (cohesive dark theme present; richer motion/illustration optional)
- QA / E2E Critic: pass (happy + failure + recovery covered)
- Regression Critic: pass (isolated feature; no shared code changed)

**Final status:**
E2E tested

**Next action:**
Manually browser-verify on localhost via Chrome/Playwright MCP and run a
post-implementation critic round, then promote to `Done`.

---

## Story record format

```md
## US-001: Short story title

**Source:** `docs/prd.md`, section "Authentication"

**User story:**
As a [user type], I want [capability], so that [benefit].

**Acceptance criteria:**
- [ ] AC1
- [ ] AC2
- [ ] AC3

**Implementation evidence:**
- Status: Not started / Partially implemented / Implemented
- Files:
  - `src/...`
- Notes:

**Test evidence:**
- Unit/component tests: Missing / Partial / Present
- E2E tests: Missing / Partial / Present
- Browser verified: No / Yes
- Evidence:
  - command output, test file, or browser observation

**Critic status:**
- Product Requirements Critic: pass / blocker / important / nice-to-have
- UX / First-Time User Critic: pass / blocker / important / nice-to-have
- Designer Critic: pass / blocker / important / nice-to-have
- Artistic Direction Critic: pass / blocker / important / nice-to-have
- QA / E2E Critic: pass / blocker / important / nice-to-have
- Regression Critic: pass / blocker / important / nice-to-have

**Final status:**
Not started / Partially implemented / Implemented / Unit tested / E2E tested / Browser verified / Done / Blocked / Deprecated

**Next action:**
One concrete next action.
```
