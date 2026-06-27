Design and run E2E tests using a multi-agent critic workflow.

Target flow:
$ARGUMENTS

Roles:

1. QA / E2E Critic
   - Defines critical paths and edge cases.

2. First-Time User Critic
   - Defines what a new user would try first.

3. UX Flow Critic
   - Defines success, failure, loading, and recovery states.

4. Accessibility Critic
   - Defines keyboard and screen-reader relevant checks.

5. Regression Critic
   - Identifies existing flows that could break.

Procedure:

1. Inspect existing Playwright tests.
2. Inspect app routes and components.
3. Start or reuse localhost.
4. Manually verify the target flow in browser.
5. Draft E2E test cases from critic findings.
6. Implement Playwright tests.
7. Run the specific E2E tests.
8. Fix test or app failures, but do not weaken assertions.
9. Run browser verification again.
10. Report evidence.

Required output:

- E2E cases added
- browser flow verified
- commands run
- failures found
- files changed
- remaining coverage gaps
