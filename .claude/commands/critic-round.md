Run a multi-agent critic review of the current local web app state.

Focus:
$ARGUMENTS

Use these critics:

1. First-Time User Critic
2. UX Flow Critic
3. Designer Critic
4. Artistic Direction Critic
5. Frontend Architecture Critic
6. QA / E2E Critic
7. Accessibility Critic
8. Performance Critic
9. Security Critic
10. Regression Critic

Procedure:

1. Inspect relevant code.
2. Start or reuse localhost.
3. Open the relevant page in Chrome or Playwright MCP.
4. Test the flow as a real user.
5. Check console errors.
6. Check failed network requests.
7. Ask each critic to independently review.
8. Return a critic matrix.

Output format:

| Critic | Severity | Finding | Evidence | Recommended action |
|---|---|---|---|---|

Classify severity:

- blocker: must fix before task is complete
- important: should fix in this task if related
- nice-to-have: record only, do not fix unless asked

Do not edit files unless explicitly asked.
