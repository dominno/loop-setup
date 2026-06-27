# Adoption Guide — using this template in a real project

This repo is a **template** for the Claude Code multi-agent critic + loop workflow,
plus a tiny Next.js starter app that proves every command runs end to end. This
guide shows how to adopt it in a real project.

There are two paths:

- **Path A — start a new project** from this template (keep the starter, then
  grow it into your app).
- **Path B — adopt the workflow** into an existing codebase (copy the workflow
  files; ignore the starter app).

The portable part is everything **except** the starter app. The starter app
(`src/`, `e2e/`, and the build configs) only exists to demonstrate the commands.

---

## What's portable vs. starter-only

**Portable — the workflow (copy these):**

```txt
CLAUDE.md                     Project rules, critic roster, completion gates
.claude/commands/*            Slash commands (/multi-agent-dev, /critic-round, /dream, ...)
.claude/loop.md               Recurring watchdog loop (used by /loop)
.claude/memory/               Knowledge wiki (index.md + topics/ + log.md)
.claude/settings.local.json   Allowed commands (adapt to your tools)
docs/*.md                     Story-map scaffolds (product-docs-index, user-stories, ...)
```

**Starter-only — demonstrates the commands (do NOT copy into an existing app):**

```txt
src/  e2e/  package.json  pnpm-lock.yaml
next.config.mjs  next-env.d.ts  tsconfig.json
eslint.config.mjs  vitest.config.ts  playwright.config.ts
docs/prd.md                   Example PRD (US-001, US-002) — reference only
```

---

## Path A — start a new project from this template

1. **Create your repo from the template.** On GitHub use **“Use this template”**,
   or clone and reset history:
   ```bash
   git clone <this-repo> my-app && cd my-app
   rm -rf .git && git init
   ```
2. **Install and confirm the baseline is green:**
   ```bash
   pnpm install
   pnpm verify        # typecheck → lint → unit → build → E2E
   ```
3. **Make it yours.** Replace the greeting starter as you build: edit `src/`,
   replace `e2e/` specs, and rewrite `docs/prd.md` with your real requirements.
4. **Reset the worked examples** when you no longer want them: clear the example
   rows in the `docs/*.md` story map (keep the headers/format) and re-seed the
   memory wiki (see “Adapt the memory wiki”).
5. **Drive development** with the commands (see “First session”).

Keeping the starter while you bootstrap is fine — it gives the critics and tests
something real to run against until your own flows exist.

---

## Path B — adopt the workflow into an existing project

1. **Copy the portable files** (above) into your repo. If you already have a
   `CLAUDE.md`, **merge** rather than overwrite — keep your project facts, add the
   “Multi-Agent …” and memory/`/dream` sections.
2. **Do not** copy `src/`, `e2e/`, the build configs, `package.json`, or the
   lockfile. Your project already has those.
3. **Wire the verification commands** to your real scripts (next section). This is
   the one step that must be correct.
4. **Adapt the memory wiki** to your stack (clear the Next/React-specific facts,
   re-seed with `/dream`).
5. **Start the story map empty** — clear the US-001/US-002 example content from
   `docs/*.md`, keep the formats, then run `/scan-project-docs` against your docs.
6. **Adjust `.claude/settings.local.json`** to the commands your tools actually use.
7. **Already have a wiki in `docs/`?** See “Reconciling with an existing `docs/`
   wiki” before step 5 — you’ll likely namespace the story map and bridge the two
   memory systems.

---

## Wire the verification commands (the contract)

Claude must know your **exact** commands and must not guess. The workflow only
references the `pnpm <script>` names in `CLAUDE.md` under **Main commands** — those
are the contract. Point each at whatever your project really runs:

| `CLAUDE.md` command | Replace with your real command |
|---|---|
| `pnpm dev` | start dev server (`npm run dev`, `vite`, `rails s`, `python manage.py runserver`, …) |
| `pnpm typecheck` | `tsc --noEmit`, `mypy`, `go vet`, … (or remove if N/A) |
| `pnpm lint` | `eslint .`, `ruff check`, `golangci-lint run`, … |
| `pnpm test` | your unit test runner |
| `pnpm test:e2e` | your E2E runner (Playwright, Cypress, …) |
| `pnpm build` | your production build |
| `pnpm verify` | the full chain, run in CI and before “done” |

Notes:
- **Different package manager?** Update the “Package manager” rule in `CLAUDE.md`
  (this template uses pnpm and forbids switching; change it to match your repo).
- **Not a web app / no localhost?** Drop the localhost + browser-verification
  steps; the critic rounds and `verify` gate still apply. Adjust the
  `http://localhost:3000` URL throughout if your port differs.
- **No E2E yet?** Keep the QA/E2E critic — it will tell you what to add. Add a real
  E2E tool when you have a user flow to cover.

---

## Adapt the memory wiki

The wiki (`.claude/memory/`) follows the Karpathy “LLM wiki” pattern: only
`index.md` is imported by `CLAUDE.md`; topic pages are read on demand. Keep the
**structure**, replace the **facts** — the seeded topic pages describe *this*
template’s stack (Next.js 16 / React 19 / Playwright 1.56) and won’t all apply to
you.

1. Skim `.claude/memory/topics/*` and delete facts that don’t match your stack
   (e.g. the `next lint` and route-announcer notes if you’re not on Next.js).
2. Keep the format: `index.md` = catalog (summary + link per topic), facts live in
   `topics/*.md`, history in `log.md`.
3. After your first real task, run **`/dream`** to ingest your own durable
   learnings, and **`/dream lint`** periodically to catch stale/orphan pages.
4. `/dream query <question>` answers from the wiki with citations.

> `/dream` is a **custom** command in this repo, not a built-in Claude Code
> feature. It builds on Claude Code’s real memory system (`@import` + `/memory`).

---

## Adapt the story map (docs/)

`docs/` holds the evidence-based product-delivery audit. To adopt:

1. Clear the example content in `docs/user-stories.md`,
   `docs/implementation-status.md`, `docs/e2e-coverage-map.md`,
   `docs/story-verification-log.md`, and `docs/gaps-and-risks.md` — keep the
   headers and table formats.
2. Put your real requirements in `docs/prd.md` (or point the scanner at your
   existing PRD/specs).
3. Run `/scan-project-docs full project` to extract stories and map evidence.
4. Keep it current with `/sync-story-status` and `/story-gap-analysis`.

Status is **evidence-based**: a story is only `Done` with implementation + passing
tests + E2E/browser verification recorded in `docs/story-verification-log.md`.

---

## Reconciling with an existing `docs/` wiki

If your project already keeps a knowledge wiki in `docs/` — especially one whose
index **indexes every file in `docs/`** — adopting this template creates two
problems. Solve them by keeping three concerns separate:

| Concern | This template | Don't confuse it with |
|---|---|---|
| **Engineering memory** — *how* to work here (stack, conventions, gotchas) | `.claude/memory/` (imported) | your domain wiki |
| **Product-delivery audit** — *what's* built/tested (stories, evidence) | `docs/` story map | your domain wiki pages |
| **Domain knowledge** — architecture, research, notes | *(your existing wiki)* | the two above |

**Problem 1 — your docs-wiki will sweep in the story map.** A wiki that auto-indexes
all of `docs/` will treat `user-stories.md`, `implementation-status.md`, `prd.md`,
etc. as wiki pages, polluting its index.

**Problem 2 — two competing memory systems.** Your domain wiki and
`.claude/memory/` overlap. Running both as “the memory” causes drift.

### Fix Problem 1 — namespace the story map

Move the delivery audit into its own subdirectory so it reads as one labeled
sub-area instead of loose pages, then tell your wiki to skip it:

```bash
mkdir -p docs/delivery
git mv docs/{product-docs-index,user-stories,implementation-status,\
e2e-coverage-map,story-verification-log,gaps-and-risks}.md docs/delivery/
# keep prd.md wherever your product docs already live
```

Then update the paths in `CLAUDE.md` (the “Documentation Scanner” file list) and in
`.claude/commands/{scan-project-docs,sync-story-status,story-gap-analysis}.md` to
point at `docs/delivery/…`, and add `docs/delivery/` to your wiki’s ignore/exclude
list (or register it in the wiki index as a single “Delivery / story status”
section rather than per-file pages).

> Prefer not to touch `docs/` at all? Move the audit out entirely, e.g.
> `delivery/` at the repo root or `.claude/delivery/`, and repoint the same files.

### Fix Problem 2 — pick ONE canonical knowledge base per concern

Choose the strategy that matches how mature your existing wiki is:

- **A. Bridge (recommended, least disruptive).** Keep `.claude/memory/` as the
  small Claude-imported memory for **operational** facts (build/verify commands,
  testing gotchas, env quirks). Add one row to `.claude/memory/index.md` that
  **links to your domain wiki’s index** as the canonical source for architecture/
  domain knowledge, read on demand. `CLAUDE.md` keeps importing only
  `.claude/memory/index.md`, so context stays small. `/dream` files operational
  learnings into `.claude/memory/` and domain learnings into your wiki (following
  its conventions).

- **B. Adopt your wiki as Claude’s memory.** If your wiki already follows the
  index + pages + log shape, make it the single store: change the import in
  `CLAUDE.md` from `@.claude/memory/index.md` to your wiki’s index (e.g.
  `@docs/wiki/index.md`), delete `.claude/memory/`, and repoint `/dream`
  (edit the paths in `.claude/commands/dream.md`) to maintain your wiki.
  **Caveat:** only do this if your wiki’s index is *small*. `@import` loads the
  whole file into every session — importing a giant “index of all docs” defeats
  the token savings. If the index is large, use strategy A instead.

- **C. Keep ours, fold yours in.** If the “wiki” is really just loose docs, migrate
  the few durable engineering facts into `.claude/memory/topics/*`, and treat
  `docs/` purely as product/domain docs that the scanner reads. 

Whichever you pick, the rule is: **one canonical home per concern, and never two
competing memory wikis.** Run `/dream lint` afterward to catch contradictions and
orphan pages introduced by the merge.

---

## Local machine vs. Claude Code on the web

The starter is tuned for **Claude Code on the web**, where Chromium is
pre-provisioned. A couple of settings differ on a normal local machine:

| Concern | Claude Code on the web | Your local machine |
|---|---|---|
| Playwright browser | Pre-provisioned at `/opt/pw-browsers`; install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; **don’t** run `playwright install` | Run `pnpm exec playwright install chromium` once |
| Browser pin | `@playwright/test` pinned to the version matching the provisioned Chromium build | You can use any current Playwright; unpin if you like |
| Manual MCP browser | Often unavailable (headless); automated E2E is the verification path | Use Chrome/Playwright MCP for manual verification |

If you only run locally, you can remove the `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
guidance and the version-pin note from `.claude/memory/topics/remote-env.md`.

---

## Tune the critics to your product

The 10 critics are general-purpose. Adjust emphasis to your product type:

- **Consumer / marketing / game / creative:** treat the **Artistic Direction
  Critic** as a hard gate.
- **Internal admin / dev tools:** the Artistic Direction Critic may file most
  findings as nice-to-have; keep Accessibility, Security, and QA strict.
- **Backend / library (no UI):** drop the UI-facing critics (Designer, Artistic
  Direction, First-Time User) and lean on Architecture, Security, QA, Regression.

Scope control stays the same: fix **blockers** and directly-related **important**
issues; record nice-to-haves; avoid unrelated refactors.

---

## Adoption checklist

```txt
[ ] Copied CLAUDE.md (merged with any existing one)
[ ] Copied .claude/commands/, .claude/loop.md, .claude/memory/, settings.local.json
[ ] Copied docs/ story-map scaffolds (content cleared, formats kept)
[ ] CLAUDE.md "Main commands" point at my real scripts
[ ] Package-manager + localhost URL/port updated to match my project
[ ] settings.local.json allows my real commands
[ ] Memory wiki: removed stack facts that don't apply; will re-seed via /dream
[ ] If a docs/ wiki already exists: namespaced the story map + picked ONE canonical
    memory home (see "Reconciling with an existing docs/ wiki")
[ ] Playwright/browser setup chosen (local install vs. web pre-provisioned)
[ ] Ran my own `verify` chain green once
[ ] Ran /scan-project-docs against my real docs
```

---

## First session

```txt
/init                       # only if you have NO CLAUDE.md yet; otherwise skip
/memory                     # view loaded memory (CLAUDE.md + the wiki index)
/scan-project-docs full project
/multi-agent-dev implement <your first feature>
/goal <feature> is complete using the multi-agent critic workflow, verified on
      localhost, covered by E2E tests, with no post-implementation critic blockers.
      Stop after 25 turns if not achieved.
/qa-pass final pre-commit check
/dream                      # capture durable learnings into the wiki
```

For a long-running session, add `/loop 10m` to keep re-checking localhost,
console errors, and the current critical flow.

---

## Troubleshooting

- **“Claude ran the wrong build/test command.”** Your `CLAUDE.md` Main commands
  don’t match your scripts. Fix the contract; it’s the single source of truth.
- **Memory advice doesn’t fit my stack.** The seeded wiki facts are from this
  template. Delete the inapplicable ones and run `/dream` to seed your own.
- **A slash command isn’t found.** Commands live in `.claude/commands/*.md`;
  confirm the file exists and you’re in the project root.
- **Permission prompts on every command.** Add the commands you trust to
  `.claude/settings.local.json` (or a shared `.claude/settings.json` for the team).
- **The starter app fails after I changed the stack.** Remove the starter
  (`src/`, `e2e/`, build configs) once your own app and tests exist; it’s only a
  demonstration.
```
