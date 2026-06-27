---
description: Self-learning pass — consolidate durable learnings from this session into project memory
argument-hint: [optional focus, e.g. "testing" or "this task"]
allowed-tools: Read, Edit, Grep, Glob, Bash(git diff:*), Bash(git log:*)
---

Run a **self-learning ("dream") pass**. Review what was actually learned in this
session and consolidate only durable knowledge into project memory.

> Note: `/dream` is a custom command in this repo, not a built-in Claude Code
> feature. It implements the memory-consolidation concept using Claude Code's real
> memory system (`.claude/memory.md`, imported by `CLAUDE.md`, plus `/memory`).

Focus (optional):
$ARGUMENTS

## Procedure

1. Review the session: the current task, what changed (use `git diff` / `git log`
   for evidence), what surprised us, and any mistake we corrected.
2. Read the existing durable memory in `.claude/memory.md` so you do not duplicate
   entries.
3. Extract **candidate learnings**. A learning qualifies only if ALL are true:
   - It is durable (stays true across future tasks, not branch- or PR-specific).
   - It is verifiable (a command, a convention, a concrete gotcha — not a vibe).
   - It is not already captured in `.claude/memory.md` or `CLAUDE.md`.
4. Classify each candidate:
   - **Append to `.claude/memory.md`** — durable facts: stack, conventions,
     gotchas, environment constraints.
   - **Propose for `CLAUDE.md`** — rules that should govern every session
     (do/don't policies, completion gates). Propose the edit; apply it.
   - **Discard** — temporary bugs, one-off incidents, anything already known.
5. Apply the updates:
   - **Append** new durable facts to the matching section of `.claude/memory.md`.
     Keep each entry to one verifiable sentence; keep the file short.
   - Editing or removing an existing entry requires explicit user confirmation —
     ask before doing it. Appending does not.
6. Report a short summary: learnings added, learnings proposed for `CLAUDE.md`,
   and candidates discarded (with the reason).

## Hard rules

- Never write secrets, tokens, passwords, API keys, or personal data to memory.
- Never record temporary or branch-specific bugs, or one-time errors already fixed.
- Prefer appending; never silently rewrite or delete existing memory.
- Do not change product code. This command only curates memory and instructions.
- If nothing durable was learned, say so and write nothing.

## Good vs. bad memory

Good: "Project uses pnpm." · "E2E specs live in `e2e/`, unit tests in `src/`." ·
"Next 16 removed `next lint`; `pnpm lint` runs `eslint .`."

Bad: "Today we fixed a flaky test on this branch." · "Temporary token is abc123." ·
"This WIP component is broken right now."
