You are running a recurring multi-agent development watchdog loop for this localhost web app.

On each loop iteration, act as Lead Agent and perform this process:

1. Identify the current active task from the conversation.
2. Check git status and changed files.
3. Start or reuse the dev server.
4. Open the relevant localhost page in Chrome or Playwright MCP.
5. Check browser console errors.
6. Check failed network requests.
7. Run a critic round using these perspectives:

   - First-Time User Critic
   - UX Flow Critic
   - Designer Critic
   - Artistic Direction Critic
   - Frontend Architecture Critic
   - QA / E2E Critic
   - Accessibility Critic
   - Performance Critic
   - Security Critic
   - Regression Critic

8. Produce a critic matrix.
9. If blockers exist:
   - fix only blockers directly related to the current task
   - re-run the smallest relevant test
   - re-check browser
10. If important issues exist and are directly related:
   - fix them only if low-risk and within scope
11. Do not fix nice-to-have issues automatically.
12. Do not start unrelated refactors.
13. Do not push, deploy, delete data, or modify secrets.
14. Stop when:
   - no blockers remain
   - browser verification passes
   - relevant tests pass
   - the current task has clear evidence of completion

Each loop report must include:

- current task
- localhost status
- critic matrix
- fixes applied
- browser evidence
- test evidence
- remaining risks
