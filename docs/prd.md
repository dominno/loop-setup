# Product Requirements — Loop Setup Starter

**Status:** Draft · **Owner:** Product · **Last updated:** 2026-06-27

## 1. Overview

The Loop Setup Starter is a minimal localhost web app used to exercise the
Claude Code multi-agent critic + loop workflow end to end. It must always have at
least one real, testable user flow so the verification commands and critic rounds
have something concrete to act on.

## 2. Goals

- Give a first-time visitor an immediate, friendly, personalized response.
- Keep the experience low-friction on repeat visits.
- Remain fully verifiable: every user-facing requirement maps to automated tests.

## 3. Non-goals

- User accounts, authentication, or any server-side persistence.
- Analytics, tracking, or collecting personal data beyond the current session.

## 4. Personas

- **First-time visitor:** has never seen the app; needs obvious next steps.
- **Returning visitor:** used the app before in the same browser; expects it to
  feel like it remembers them.

## 5. Requirements

### 5.1 Greeting (implemented)

A visitor can enter their name and receive a personalized greeting.

**Acceptance criteria**
- AC1: Submitting a valid name shows `Hello, <name>! Welcome aboard.`
- AC2: Submitting an empty or whitespace-only name shows an inline validation
  error and no greeting.
- AC3: Names longer than 40 characters are rejected with a clear message.
- AC4: Correcting the input after an error replaces the error with a greeting.

### 5.2 Remember me on return (not yet implemented)

A returning visitor should not have to retype their name. After a successful
greeting, the app remembers the last name **in the browser only** (no server) and
pre-fills it on the next visit, with a clear way to clear it.

**Acceptance criteria**
- AC1: After a successful greeting, the name is persisted to `localStorage`.
- AC2: On reload, the name input is pre-filled with the remembered name and the
  greeting for that name is shown automatically.
- AC3: A visible "Not you? Clear" control removes the remembered name and resets
  the form to its empty state.
- AC4: Nothing is persisted when validation fails (no remembered value is written
  for an invalid name).
- AC5: No personal data leaves the browser; persistence is `localStorage` only.

## 6. Success metrics

- 100% of acceptance criteria covered by unit and/or E2E tests.
- All critic rounds pass with no blockers before a story is marked `Done`.
