# Project Memory — Index

The **always-loaded catalog** of the project knowledge wiki (Andrej Karpathy's
"LLM wiki" pattern). The kit's SessionStart hook injects **only this file's topic rows** into every
session, so it must stay small. Detailed knowledge lives in topic pages under
`.claude/loop-workspace/topics/` and is read **on demand** — never all at once. History
lives in `.claude/loop-workspace/log.md`. Loop **state** (not knowledge) lives beside it:
`loop-plan.md` is the loop's current plan/DAG (the mutable watchlist every loop action
traces to) and `loop-run-log.md` is the append-only run history — neither is a topic
page; both are read only by a running `/loop`. `trace/records.jsonl` is the append-only
TRACE-lite record store (written only via `loop-setup`) and `quarantine.md` holds
candidate facts the `/dream` admission gate deferred — neither is part of the wiki.

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

## Wiki rules
- **Raw source** for ingests is the session + git history (ephemeral); there is no
  `raw/` directory to store.
- Append-only by default; removing or rewriting an existing fact needs explicit
  user confirmation.
- One verifiable fact per bullet. No secrets; no temporary or branch-specific bugs.
- Adding a topic → create a page under `topics/` and add one row above.
- Keep this index to summaries and links only; facts belong in topic pages.
- **Log rotation:** when `log.md` exceeds **500 lines**, `/dream lint` rolls the
  older entries into yearly archives `.claude/loop-workspace/log/<YYYY>.md`, keeping the
  recent window in `log.md`. The log is not imported, so this is about read/append
  cost, not session context.
