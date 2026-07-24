---
description: Self-learning pass — ingest durable learnings into the project knowledge wiki and lint it
argument-hint: [ingest | query <question> | lint] (default: ingest this session)
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(git diff:*), Bash(git log:*)
---

Run a **self-learning ("dream") pass** over the project knowledge wiki at
`.claude/memory/` (Karpathy "LLM wiki" pattern). Maintain it; do not dump
everything into one file.

> Note: `/dream` is a custom command in this repo, not a built-in Claude Code
> feature. It implements memory consolidation on top of Claude Code's real memory
> system (`.claude/memory/index.md` is imported by `CLAUDE.md`; `/memory` views it).

Mode (optional):
$ARGUMENTS

## Wiki layout
- `.claude/memory/index.md` — small catalog, imported every session. Summaries +
  links only, no facts. **Keep it small.**
- `.claude/memory/topics/*.md` — one page per subject; the actual facts live here.
- `.claude/memory/log.md` — append-only operation history.

## Operations

### ingest (default)
1. Review the session: the task, what changed (`git diff` / `git log` for
   evidence), what surprised us, any mistake we corrected.
2. Read `.claude/memory/index.md`, then read the topic pages a candidate would
   touch, so you do not duplicate existing facts.
3. Extract **candidate learnings**. A learning qualifies only if ALL are true:
   - durable (true across future tasks, not branch- or PR-specific);
   - verifiable (a command, convention, or concrete gotcha — not a vibe);
   - not already captured in a topic page.
4. File each learning into the **single most relevant topic page** as one
   verifiable bullet. If it fits no existing page, create a new
   `topics/<slug>.md`, add cross-links, and add one row to `index.md`.
5. If a learning is really a session-governing rule (a do/don't policy or a
   completion gate), it belongs in `CLAUDE.md`. Show the proposed `CLAUDE.md` edit and
   apply it **only after explicit confirmation** — `CLAUDE.md` is a core governing
   prompt (it overrides every session), so it always needs confirmation, even for an
   addition. Topic-page and index-row additions do not.
6. **Skills check.** Decide whether the learning is a *fact* or a *recurring
   procedure*:
   - A **fact** (gotcha, convention, command) → a topic page, as above.
   - A **recurring procedure** we've now done a few times (same multi-step
     workflow) → it may deserve its own skill. Do **not** auto-create it. Instead
     **propose** a new `.claude/commands/<name>.md`: show the proposed `description`
     frontmatter, `argument-hint`, and body, and create it only on confirmation.
     When a skill is added or changed, update `.claude/skills-index.md` (add/adjust
     its row and the "Pick by intent" line). Adding an index row is additive — no
     confirmation needed; the skill file itself needs confirmation.
7. Append one entry to `log.md`: `## [YYYY-MM-DD] ingest | <summary>`.

### query <question>
1. Read `index.md`, open only the relevant topic page(s), answer with citations
   (which page each fact came from). Optionally file the answer back as a page.

### lint
1. Health-check the wiki: contradictions between pages, stale claims newer work
   has superseded, orphan pages with no inbound links, concepts mentioned without
   their own page, missing cross-references, and an `index.md` that drifted from
   the topic pages.
2. Health-check the **skills index** (`.claude/skills-index.md`): every command in
   `.claude/commands/*.md` has a `description` and a row in the index; **flag**
   (report, don't auto-remove) any index rows for commands that no longer exist and
   any near-duplicate commands.
2b. Health-check the **workflow diagrams** (`docs/workflow-graphs.md`) against
   `.claude/workflows/*.js`: for each workflow, confirm the diagram's node labels,
   model tier (🟢/🔵/⚪/▫️), and edges (parallel/pipeline/gates) match the script's
   `CRITICS`/`LENSES`/`DIMENSIONS`/`CATEGORIES` arrays and `FANOUT_MODEL`/`JUDGE_MODEL`
   usage; **report (don't auto-fix)** any diagram that has drifted from its script.
3. Auto-fix only additive/clerical issues (broken links, a missing index row, a
   missing `description`). Everything else — removing a dead index row, deleting a
   command, merging duplicates, or removing/rewriting a fact — is **reported only**
   and needs confirmation before you act.
4. **Rotate the log if needed.** If `log.md` exceeds **500 lines**, move the older
   entries (keep roughly the most recent ~200 lines as the working window) into
   yearly archives `.claude/memory/log/<YYYY>.md` — create the file if absent, or
   append in chronological order if it exists. Group moved entries by the year in
   their `[YYYY-MM-DD]` header. This is a **lossless move** (nothing is deleted), so
   lint may do it without separate confirmation; preserve every entry verbatim. If
   `log.md` is ≤ 500 lines, do nothing.
5. Append a `## [YYYY-MM-DD] lint | <summary>` entry to `log.md`. **If you rotated
   in step 4, append a *separate* `## [YYYY-MM-DD] rotate | moved <n> entries to
   log/<YYYY>.md` entry** — rotation always gets its own `rotate` entry, never
   folded into the `lint` entry (the prefixes are structured markers).

## Hard rules
- Never write secrets, tokens, passwords, API keys, or personal data to the wiki.
- Never record temporary or branch-specific bugs, or one-time errors already fixed.
- Prefer appending; editing or removing an existing fact needs explicit user
  confirmation. Adding a topic or an index row does not.
- Adding or changing a rule in `CLAUDE.md` (a core governing prompt), unlike adding a
  topic-page fact, **always** needs explicit confirmation.
- Never auto-create, rewrite, or delete a command/skill. Propose it and act only on
  confirmation. Updating `.claude/skills-index.md` rows additively is fine.
- Keep `index.md` to summaries + links; facts belong in topic pages.
- Do not change product code. This command only curates memory and instructions.
- If nothing durable was learned, say so and write nothing (but you may still log a
  `lint` pass if asked).

## Good vs. bad memory
Good: "Project uses pnpm." · "E2E specs live in `e2e/`, unit tests in `src/`." ·
"Next 16 removed `next lint`; `pnpm lint` runs `eslint .`."

Bad: "Today we fixed a flaky test on this branch." · "Temporary token is abc123." ·
"This WIP component is broken right now."
