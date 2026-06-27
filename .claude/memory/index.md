# Project Memory — Index

The **always-loaded catalog** of the project knowledge wiki (Andrej Karpathy's
"LLM wiki" pattern). `CLAUDE.md` imports **only this file**, so it loads every
session and must stay small. Detailed knowledge lives in topic pages under
`.claude/memory/topics/` and is read **on demand** — never all at once. History
lives in `.claude/memory/log.md`.

> Links below are plain markdown (not `@imports`), so topic pages are NOT
> auto-loaded. Open the ones relevant to the current task.

## How to use (every task)
1. Scan this index for topics relevant to the task.
2. Open only the relevant topic page(s) before acting (the "query" operation).
3. At the end of a non-trivial task, run `/dream` to file new learnings into the
   right topic page, update this index if a page was added, and append to `log.md`.

## Topics
| Topic | What's inside | Page |
|---|---|---|
| Tooling & stack | package manager, framework/library versions, app URL | [topics/tooling.md](./topics/tooling.md) |
| Build & verify | verify chain, ESLint flat-config gotchas | [topics/build-and-verify.md](./topics/build-and-verify.md) |
| Testing | unit vs E2E scoping, Playwright/Vitest gotchas | [topics/testing.md](./topics/testing.md) |
| Client components (React 19) | hooks/store patterns, hydration, localStorage | [topics/client-react.md](./topics/client-react.md) |
| Code organization | where routes/api/domain/components live | [topics/code-organization.md](./topics/code-organization.md) |
| Remote env (web) | pre-provisioned Chromium, Playwright pin, MCP limits | [topics/remote-env.md](./topics/remote-env.md) |
| Workflow & docs | /dream, doc-scanner, PRD source of record | [topics/workflow.md](./topics/workflow.md) |

## Wiki rules
- **Raw source** for ingests is the session + git history (ephemeral); there is no
  `raw/` directory to store.
- Append-only by default; removing or rewriting an existing fact needs explicit
  user confirmation.
- One verifiable fact per bullet. No secrets; no temporary or branch-specific bugs.
- Adding a topic → create a page under `topics/` and add one row above.
- Keep this index to summaries and links only; facts belong in topic pages.
