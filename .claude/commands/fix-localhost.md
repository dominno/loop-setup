---
description: Diagnose (root cause first) and fix the app until localhost loads cleanly with no blocking console/network errors. Use when the dev server or localhost is broken or throwing on load.
---

Fix the local web app until localhost works correctly.

Success criteria:

- Dev server starts successfully.
- localhost:3000 loads without a fatal error.
- No blocking browser console errors on initial load.
- No failed required network requests on initial load.
- Typecheck, lint, and relevant tests pass.
- Post-fix critic round has no blockers.

Procedure:

1. Run the dev server.
2. Open localhost with Chrome or Playwright MCP.
3. Capture the exact browser/terminal error.
4. Run this critic round:
   - First-Time User Critic
   - Frontend Architecture Critic
   - QA / E2E Critic
   - Regression Critic
5. Diagnose root cause.
6. Apply the smallest safe fix.
7. Re-test in browser.
8. Run typecheck, lint, and tests.
9. Run a post-fix critic round.
10. Summarize evidence.
