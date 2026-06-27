Scan the project documentation and create/update user stories, implementation status, and E2E coverage maps.

Scope:
$ARGUMENTS

You are Lead Agent: Product Delivery Auditor.

Use these critic agents:

1. Product Requirements Critic
2. User Story Critic
3. Acceptance Criteria Critic
4. Code Evidence Critic
5. Unit Test Evidence Critic
6. E2E Test Evidence Critic
7. UX / First-Time User Critic
8. Designer Critic
9. Artistic Direction Critic
10. Regression Critic
11. Documentation Consistency Critic

Procedure:

1. Read `CLAUDE.md`.
2. Find product docs, PRDs, specs, README files, planning docs, route docs, API docs, and existing story docs.
3. Create or update `docs/product-docs-index.md` with scanned sources.
4. Extract product requirements.
5. Convert requirements into user stories.
6. Split large stories into independently testable stories.
7. Add measurable acceptance criteria.
8. Search the codebase for implementation evidence.
9. Search the test suite for unit, integration, and E2E evidence.
10. Start or reuse localhost when browser verification is possible.
11. Open relevant pages using Chrome or Playwright MCP.
12. Verify implemented user flows in browser when possible.
13. Check console errors and failed network requests.
14. Update:
    - `docs/user-stories.md`
    - `docs/implementation-status.md`
    - `docs/e2e-coverage-map.md`
    - `docs/story-verification-log.md`
    - `docs/gaps-and-risks.md`
15. Run a post-scan critic review.
16. Do not change product code unless explicitly asked.
17. Do not mark stories `Done` without implementation evidence, test evidence, and verification evidence.

Output:

- number of docs scanned
- number of stories created/updated
- status summary by category
- stories marked Done
- stories missing implementation
- stories missing E2E tests
- stories blocked by unclear docs
- files updated
