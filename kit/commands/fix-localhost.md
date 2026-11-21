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
- Post-fix single-agent self-review has no blockers.

Procedure:

1. Run the dev server.
2. Open localhost with Chrome or Playwright MCP.
3. Capture the exact browser/terminal error.
4. As Lead Agent, self-review the failure inline through these four lenses — this
   command is intentionally **single-agent**: do NOT fan out to the critic-panel
   Workflow. (If a full critic round is warranted, invoke `/critic-round` separately.)
   List each finding with severity + evidence:
   - First-Time User
   - Frontend Architecture
   - QA / E2E
   - Regression
5. Diagnose root cause.
6. Apply the smallest safe fix.
7. Re-test in browser.
8. Run typecheck, lint, and tests.
9. Repeat the single-agent self-review (step 4) after the fix; if the fix is
   non-trivial, run `/critic-round` (the critic-panel Workflow) instead.
10. Summarize evidence.
