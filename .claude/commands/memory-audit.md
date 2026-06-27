---
description: Audit project memory/instructions for stale, duplicated, or misleading entries and recommend changes (never deletes without confirmation). Use periodically or when memory feels stale or contradictory.
---

Audit Claude Code project memory and instructions.

Procedure:

1. Open /memory or inspect the project memory files if available.
2. Identify stale, duplicated, or misleading memory.
3. Compare memory with CLAUDE.md.
4. Recommend what should be moved to CLAUDE.md.
5. Recommend what should stay in auto memory.
6. Recommend what should be deleted.
7. Do not delete memory without explicit confirmation.

Good memory examples:

- This project uses pnpm.
- E2E tests require the dev server on localhost:3000.
- Auth tests require mocked session storage.
- Use src/app/api for API routes.

Bad memory examples:

- Temporary branch-specific bugs.
- One-time errors already fixed.
- Secrets, tokens, passwords, API keys.
- Temporary implementation details that will change soon.
