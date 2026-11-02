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
.claude/workflows/*           Multi-agent orchestration scripts (critic-panel, scan-docs, ...)
.claude/loop.md  loop-checklist.md   Recurring watchdog loop + readiness rubric (used by /loop)
.claude/memory/               Knowledge wiki (index.md + topics/ + log.md + loop-run-log.md + loop-plan.md)
.claude/memory/trace/  quarantine.md   TRACE-lite record store (start it EMPTY) + /dream quarantine;
                              with an empty store, strip the topic pages' <!-- rec:TR-… --> comments
                              (pnpm trace wiki-check lists them) and keep those facts as legacy bullets
.claude/trace/                TRACE-lite schema + bench fixtures (rewrite the fixtures for your app)
scripts/trace/                `pnpm trace` CLI + its tests (add "trace": "node scripts/trace/cli.mjs"
                              to package.json and scripts/**/*.test.mjs to your unit-test globs)
.claude/skills-index.md       Command catalog: which slash command fits which task
.claude/settings.json         Shared permissions (merge into yours; adapt the allow-list)
.claude/hooks/stop-gate.mjs   Optional: the opt-in advisory Stop hook, enabled by no settings file (see
                              "Optional hooks"); its tests are scripts/hooks/stop-gate.test.mjs
docs/*.md  docs/stories/      Story-map scaffolds (user-stories index, stories/ per-story files, ...)
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
6. **Merge `.claude/settings.json`** — see “Permissions” below: allow only your
   real commands, keep the force-push/hard-reset denies, and put any personal
   `git add`/`git commit` auto-allow in your own `.claude/settings.local.json`.
7. **Already have a wiki in `docs/`?** Read “Reconciling with an existing `docs/`
   wiki” before you start the story map (step 5) — you’ll likely namespace the
   story map and bridge the two memory systems.
8. **Already have your own slash commands or notes?** See “Integrating existing
   skills and old learnings” — give each command a `description` + a
   `.claude/skills-index.md` row, and triage notes into the wiki.

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

> ⚠️ **Trim `verify` to the steps you actually have.** `pnpm verify` is a hard
> `&&` chain of five scripts. If your project has no `typecheck` or no `test:e2e`,
> the chain fails immediately and the whole "definition of done" gate is unusable.
> Define `verify` from only the scripts that exist, e.g. a minimal:
> `"verify": "npm run lint && npm test"`. Add steps back as you add the tooling.

Notes:
- **Different package manager?** Update the “Package manager” rule in `CLAUDE.md`
  (this template uses pnpm and forbids switching; change it to match your repo).
- **Not a web app / no localhost?** Drop the localhost + browser-verification
  steps; the critic rounds and `verify` gate still apply. Adjust the
  `http://localhost:3000` URL throughout if your port differs.
- **No E2E yet?** Keep the QA/E2E critic — it will tell you what to add. Add a real
  E2E tool when you have a user flow to cover.
- **Monorepo / app in a subdirectory?** `.claude/` and `CLAUDE.md` usually sit at
  the repo root, but the commands and memory reference `src/`, `e2e/`, and
  `localhost:3000`. Update those paths/ports to your package’s layout, run commands
  from the right workspace, and consider a per-package `CLAUDE.md` for big monorepos.

---

## Permissions (`settings.json`)

The template ships a committed **`.claude/settings.json`**, so every clone gets the
same rules:

- **allow** — the verification commands (`pnpm dev`, `typecheck`, `lint`, `test`,
  `test:e2e`, `build`, `verify`, `check:bundle`), an exact `pnpm install` (plus
  `pnpm install --frozen-lockfile`, never `pnpm install <pkg>`), `git status`,
  `git diff`, and the read-only TRACE calls (`pnpm -s trace query`/`tree-id`,
  `pnpm trace show`/`lint`/`metrics`). The bench commands keep their prompt, and so do
  TRACE record writes (`pnpm trace write`/`act`), except inside a `/dream` turn, whose
  `allowed-tools` pre-approves the `write`, `act`, `reaudit` and `rotate` subcommands
  it runs.
- **deny** — force-pushes (`--force`, `--force-with-lease`, `-f`, a `+` refspec) and
  `git reset --hard`. A plain `git push` is never denied: no allow rule can override a
  deny, and the loop and commit flows still have to push.
- **`worktree.baseRef: "head"`** — worktree-isolated agents (the `/loop` implementer)
  branch from your local `HEAD`, so they see unpushed commits. It also sets the base
  of your own `claude --worktree` sessions in this repo.

Before you copy it:

- **Merge, don't overwrite.** If your repo already has a `.claude/settings.json`,
  merge these rules into it, and swap the `pnpm …` entries for your real commands.
- **Git auto-allow is a personal opt-in.** Nothing shared lets the agent run
  `git add`/`git commit` without a prompt. To allow it for yourself, put the rules in
  your own `.claude/settings.local.json`; Claude Code combines its `allow` list with
  the shared one. Keep that file git-ignored (Claude Code also saves your “don’t ask
  again” approvals there):

  ```json
  {
    "permissions": {
      "allow": ["Bash(git add:*)", "Bash(git commit:*)"]
    }
  }
  ```

  An allow rule is a convenience, not a license: `CLAUDE.md` still says to commit
  only when asked.
- **Allow rules wait for workspace trust; deny rules apply at once.** A teammate gets
  the shared `allow` rules only after accepting the trust dialog for the folder (a
  `claude -p` or SDK run in a folder nobody trusted ignores them), while `deny` and
  `ask` rules apply immediately. A deny rule is a speed bump, not a security boundary:
  it matches the command text, so `git -C . push --force` or a `bash -c '…'` wrapper
  slips past it.
- **Cloud sessions.** A single-repository cloud session reads the committed
  `.claude/settings.json` (never `settings.local.json`, which is not in the clone).
  Cloud threads in a claude.ai Project apply none of a repository's permission rules,
  hooks or `env`.
- **`allowed-tools` pre-approves; it never restricts.** A command's `allowed-tools`
  frontmatter lets the listed tools run without a prompt until your next message, and
  workspace trust does not gate it, so keep it narrow (`/dream` lists only the
  `pnpm trace` subcommands it runs). This template never pre-approves `Workflow`:
  every multi-agent fan-out keeps your approval.
- **Keep agent leftovers out of git and lint.** Git-ignore `.claude/settings.local.json`
  and `.claude/worktrees/` (where worktree-isolated agents check out), and add
  `.claude/worktrees/**` to your linter's ignores. ESLint's flat config does not read
  `.gitignore`, so a leftover worktree would otherwise turn `lint` red.

### Optional hooks

The template enables **no hooks**. It ships one tested, opt-in Stop hook,
`.claude/hooks/stop-gate.mjs` (tests in `scripts/hooks/stop-gate.test.mjs`; it imports
`scripts/trace/lib.mjs`). At the end of a turn it runs the unit suite once per
working-tree state and, when tests fail, shows you one line:
`stop-gate: N unit test file(s) failing — advisory; run pnpm test`. It is advisory: it
never blocks the turn, always exits 0, and is never evidence that work is done (your own
check run is).

To try it, add this to your own `.claude/settings.local.json` (git-ignored, so it stays
personal), next to its `permissions`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/stop-gate.mjs\"", "timeout": 120 }
        ]
      }
    ]
  }
}
```

- **A sync hook delays every turn end.** A run costs about one `pnpm test`; the gate kills
  it after 90 s and reports "timed out … no result" (keep `timeout` at 120 so the hook can
  stop itself first). It skips an unchanged tree, a tree it already reported, a turn that a
  Stop hook is already continuing, a worktree where another session's gate is running, any
  background workflow, subagent, teammate or cloud session, and any background task that
  mentions a test, bench or trace run. It acts only on `Stop`: registered under any other
  event (`SubagentStop`, say, or a tool event), it does nothing.
  `STOP_GATE=0` turns it off. `STOP_GATE_MODE=related` runs only `vitest related` on
  changed `src/` files plus `GLOBAL_GATES`, the tests that read files by path (add yours to
  that list); any other change runs the full suite.
- **It never runs E2E**, a build or a dev server.
- **Its message reaches you, not Claude.** A sync hook's `systemMessage` is shown to the
  user only. The `asyncRewake` hook option would wake the model instead (on exit code 2),
  at a token cost each time it wakes the model; the gate does not use it.
- **Committed hooks run in every session.** A hook in a committed settings file runs for
  every adopter and in this repo's single-repo cloud sessions, which is why this one is
  opt-in.
- **Never add a `PreToolUse` or `PostToolUse` hook that prints.** Tool events fire inside
  workflow subagents too, the measured loop verifier included, so its output would change
  what the verifier sees. `scripts/trace/config.test.mjs` fails on any tool-event hook in
  the committed `.claude/settings.json`.
- Its manifest, lock and log live under `git rev-parse --git-path` (per worktree), never
  in the tree; the log holds counts and exit codes only.

---

## Adapt the memory wiki

The wiki (`.claude/memory/`) follows the Karpathy “LLM wiki” pattern: only
`index.md` is imported by `CLAUDE.md`; topic pages are read on demand. Keep the
**structure**, replace the **facts** — the seeded topic pages describe *this*
template’s stack (Next.js 16 / React 19 / Playwright 1.56) and won’t all apply to
you.

> ⚠️ **Clear the seeded facts FIRST — before your first real task.** The
> wiki ships with this template’s stack facts (e.g. "Next 16 removed `next lint`",
> the Playwright pin). They load every session as *authoritative memory*. If you
> skip this on, say, a Python or Vite repo, Claude will quietly act on false facts
> with no error — the worst kind of failure. Treat clearing them as step 0.

1. Skim `.claude/memory/topics/*` and delete facts that don’t match your stack
   (e.g. the `next lint` and route-announcer notes if you’re not on Next.js).
2. Keep the format: `index.md` = catalog (summary + link per topic), facts live in
   `topics/*.md`, history in `log.md`.
3. After your first real task, run **`/dream`** to ingest your own durable
   learnings, and **`/dream lint`** periodically to catch stale/orphan pages.
4. **Mind the import path.** `CLAUDE.md` pulls the wiki in with a *relative* import
   (`@.claude/memory/index.md`). If you merge our content into a `CLAUDE.md` at a
   different depth, or move the wiki, fix that path or it silently won’t load.
   Claude Code also shows a one-time approval dialog the first time it sees the
   import — that’s expected.
5. `/dream query <question>` answers from the wiki with citations.

> `/dream` is a **custom** command in this repo, not a built-in Claude Code
> feature. It builds on Claude Code’s real memory system (`@import` + `/memory`).

---

## Adapt the story map (docs/)

`docs/` holds the evidence-based product-delivery audit. **Each user story is its
own file** under `docs/stories/US-<id>-<slug>.md` (so the backlog scales to a large
project); `docs/user-stories.md` is the index and `docs/implementation-status.md`
is the evidence dashboard. To adopt:

1. Delete the example story files (`docs/stories/US-001-*.md`,
   `docs/stories/US-002-*.md`) but **keep `docs/stories/_TEMPLATE.md`**. Clear the
   example rows in `docs/user-stories.md`, `docs/implementation-status.md`,
   `docs/e2e-coverage-map.md`, `docs/story-verification-log.md`, and
   `docs/gaps-and-risks.md` — keep the headers and table formats.
2. Put your real requirements in `docs/prd.md` (or point the scanner at your
   existing PRD/specs).
3. Run `/scan-project-docs full project` — it writes one file per story under
   `docs/stories/` and updates the index + dashboard.
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
git mv docs/stories docs/delivery/stories       # the per-story files move too
# keep prd.md wherever your product docs already live
```

Then update the paths in `CLAUDE.md` (the “Documentation Scanner” file list) and in
`.claude/commands/{scan-project-docs,sync-story-status,story-gap-analysis}.md` to
point at `docs/delivery/…`, and add `docs/delivery/` to your wiki’s ignore/exclude
list (or register it in the wiki index as a single “Delivery / story status”
section rather than per-file pages).

Also set `STORY_MAP` in `scripts/trace/story-map.mjs` to the new directory (e.g.
`"docs/delivery"`): `pnpm trace story-lint` reads the story map there, and an absent
story map passes vacuously, so a stale path would check nothing.

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
  its conventions). **Step-by-step walkthrough below.**

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

### Bridge, step by step (strategy A in detail)

The bridge keeps both wikis but gives each a single job and a one-way link from the
small imported memory to the large product/domain wiki. Nothing big gets imported;
the product wiki is **read on demand**.

Assume your existing wiki’s entry point is `docs/wiki/index.md` (adjust paths to
yours).

**1. Add a bridge entry to `.claude/memory/index.md`.** Use a plain markdown link,
**not** an `@import` — `@` would pull the whole product wiki into every session.
From `.claude/memory/`, the repo root is two levels up:

```md
## Bridged knowledge bases (read on demand — NOT imported)
| Knowledge base | Use it for | Entry point |
|---|---|---|
| Product / domain wiki | features, architecture, domain rules, research | [../../docs/wiki/index.md](../../docs/wiki/index.md) |
```

**2. Add a thin map page `.claude/memory/topics/domain-wiki.md`** so the agent knows
the other wiki exists, how it’s organized, and when to open it:

```md
# Domain / product wiki (bridge)

Canonical knowledge base for **product and domain** facts is the existing wiki at
`docs/wiki/` (entry: `docs/wiki/index.md`). It is NOT imported — open it on demand.

- Use it for: features, requirements, architecture, domain/business rules, research.
- Structure: (describe briefly — e.g. an index.md catalog + one page per feature).
- Navigate via its `index.md`; follow its own conventions when adding pages.

Related: [workflow](./workflow.md)
```

Add a row for this page in the `index.md` Topics table too, so it’s in the catalog.

**3. Write down the routing rule** (in `domain-wiki.md` and, optionally, as a one
line note in `.claude/commands/dream.md`) so new learnings land in the right store:

| A new learning about… | Goes to… |
|---|---|
| commands, lint/test gotchas, env, file layout, “how we work” | `.claude/memory/topics/*` |
| a feature’s behavior, business/domain rules, architecture | the product/domain wiki |
| a product story and its build/test status | the `docs/` delivery story map |

**4. (Optional) Cross-link back** from the product wiki’s index to
`.claude/memory/index.md`, so humans and agents starting in `docs/wiki/` discover
the engineering memory too.

**5. Confirm the import stays small.** `CLAUDE.md` still imports only
`@.claude/memory/index.md`. The product wiki is reached by following links, never
loaded wholesale. Verify with `/memory` that only the small index is loaded.

**6. Run `/dream lint`** to check the new bridge page is linked (not an orphan) and
that nothing contradicts existing topics.

After this, a session works like: `CLAUDE.md` → imports the small memory index →
for a domain question the agent follows the bridge link into `docs/wiki/` and reads
only the relevant page; for a “how we build/test” question it reads a
`.claude/memory/topics/*` page. Two maps, one entry point, no duplicated context.

---

## Integrating existing skills and old learnings

If your project already has its own slash commands/skills or accumulated notes,
fold them into the two catalogs instead of leaving them disconnected.

### Existing slash commands / skills

Your commands in `.claude/commands/` coexist with the template’s. To make them
first-class:

1. **Check for name collisions BEFORE copying.** Copying `.claude/commands/*` over
   a repo that already has a `qa-pass.md`, `critic-round.md`, `dream.md`, etc. will
   silently overwrite one with the other. Also remember user-level
   `~/.claude/commands/` can shadow/clash with project ones. Diff the two command
   sets first; rename or merge conflicts deliberately, don’t clobber.
2. **Add a `description`** (and `argument-hint` if it takes input) to each — this
   is what Claude routes on. Without it, selection falls back to the filename.
3. **Decide what may auto-fire — the manual-only rule.** A `description` doesn’t just
   help *you* choose — Claude can **auto-invoke** the command from a matching request.
   `disable-model-invocation: true` stops that (you still type `/name`), but it also
   blocks Claude’s Skill call and hides the command, so Claude can no longer run it
   even where `CLAUDE.md` tells it to. Make a command **manual-only** only if it
   rewrites the governing prompt surface (as `/improve-skills` does) or runs a measured
   fan-out that `CLAUDE.md` never tells Claude to run (as `/bench-checkers` does), and
   mark its `.claude/skills-index.md` row `(manual-only)`. Any command `CLAUDE.md` tells
   Claude to run (here `/dream`, `/multi-agent-dev` and the doc-scanner commands) stays
   model-invocable. Cost is bounded elsewhere: the engine workflows stay model-invocable
   skills, so the bound is their own per-call caps and token-budget floor checks (*Cost
   is real*, under Multi-agent orchestration below); in Auto mode, the Workflow approval
   appears only on the first launch. `pnpm test` fails when a command’s flag and its
   index row disagree.
4. **Add a row to `.claude/skills-index.md`** under the right group, with a
   one-line “when to use”.
5. **Resolve overlaps.** If your command duplicates a template one (e.g. your
   `/qa` vs `/qa-pass`), keep one, merge the best of both, and remove the other
   (deleting a command is a confirmed step in the `/dream` flow).
6. **Run `/dream lint`** — it flags commands missing a `description` or an index
   row, and near-duplicates.
7. **Catalog files don’t belong in `.claude/commands/`** — anything there
   auto-registers as its own `/command`. The skills catalog lives at
   `.claude/skills-index.md` for that reason.

### Old / scattered learnings (notes, READMEs, an old `CLAUDE.md`)

Don’t bulk-paste them into the wiki. Triage each item by destination:

| The note is… | Goes to… |
|---|---|
| a durable engineering fact (command, convention, gotcha) | `.claude/memory/topics/*` — one verifiable bullet |
| a session-governing rule (do/don’t, completion gate) | `CLAUDE.md` |
| product / domain knowledge | your domain wiki (see “Reconciling…”) or `docs/` |
| a temporary / branch-specific bug or one-off | discard — don’t memorize it |

- Use **`/dream ingest`** to help extract durable learnings from a notes file, but
  review each line before committing — `/dream` is told to drop secrets, temporary
  bugs, and vibes, but you are the last check. **Never let a token, password, or
  key land in the wiki** (it’s committed and shared).
- Add one `index.md` row per new topic page, then run **`/dream lint`**.
- If you had a single-file memory (as this template once did), split it into topic
  pages — see how this repo migrated in `.claude/memory/log.md`.

### Migration checklist

```txt
[ ] Checked for command NAME collisions before copying (no silent clobber)
[ ] Existing commands kept; each given a description (+ argument-hint)
[ ] disable-model-invocation: true only per the manual-only rule (.claude/skills-index.md),
    with (manual-only) in its index row; never on a command CLAUDE.md tells Claude to run
[ ] Each existing command added to .claude/skills-index.md, grouped
[ ] Duplicate commands merged (one canonical per job)
[ ] Old notes triaged: facts → memory topics, rules → CLAUDE.md,
    domain → wiki, junk → dropped; no secrets memorized
[ ] /dream lint clean: no missing descriptions, orphan pages, or dead index rows
```

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

## Driving work: let Claude write the `/goal`

The template follows the "let the agent write its own `/goal`" practice — Claude
knows the project's gates better than a hand-written prompt. You inherit:

- **A power-move instruction** in `CLAUDE.md` ("Writing `/goal` and `/loop`
  prompts"): when you describe a non-trivial task, Claude first **offers to write
  the `/goal`** instead of silently starting.
- **The `/write-goal` command** — turns a described outcome into a copy-pasteable
  `/goal` (or `/loop`) that includes all six parts: a one-line task statement,
  3–5 **measurable** success criteria, constraints, **checkpoint rules** (pause vs.
  run-through), a **self-verify** instruction, and a **max-budget guard**
  (e.g. "stop after N turns").

To adapt it: the generated criteria reference this repo's gates (`pnpm verify`,
E2E coverage, no critic blockers) — once you've wired your own commands (above),
`/write-goal` will cite *those*. Usage:

```txt
/write-goal add password reset and verify it end to end
# → review the /goal it prints, then run it (don't skip to /multi-agent-dev)
```

### Recurring loops are hardened

For recurring/watchdog work (`/loop`, used via `.claude/loop.md`), the template
applies "loop engineering" operating rules (adapted from
[loop-engineering](https://github.com/cobusgreyling/loop-engineering)): declare a
**trust level** — **L1 report-only → L2 assisted → L3 unattended** — and keep the
loop inside it; read/write the append-only `.claude/memory/loop-run-log.md` each
iteration; honor the **denylist** (auth, payments, secrets, infra, CI config, migrations),
the **escalation triggers**, and the **red-flag stop conditions** (e.g. >3 fix
attempts on one item, verifier == implementer, auto-merge without an allowlist).
Before raising a loop to a higher trust level, satisfy `.claude/loop-checklist.md`.
Adopters should start every new loop at **L1** and only promote it once the
checklist passes.

For a full step-by-step (copy list, scope/cadence, budget, loop-pattern recipes,
worktree isolation, and a first-loop walkthrough), see
[`loop-integration-guide.md`](./loop-integration-guide.md).

---

## Continuous integration (CI)

The template ships `.github/workflows/verify.yml` — a GitHub Actions workflow that
runs the `verify` chain on every push to `main` and every PR, so the green bar is
enforced automatically (this is the "run in CI" half of the verification contract).

It runs the checks as **parallel jobs**: a matrix runs `typecheck`, `lint`, `test`,
and `build` concurrently (`fail-fast: false`, so you see *all* failures at once),
and a separate `e2e` job runs Playwright. Each appears as its own status check, so
you can mark them **required** in branch protection to block merges on red.

Adapt it to your stack:

- **Browser install (the key CI difference).** GitHub Actions has **no**
  pre-provisioned Chromium, so the `e2e` job runs
  `pnpm exec playwright install --with-deps chromium`. This is the normal install —
  do **not** copy the web env’s `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` flag into CI.
- **Match the matrix to your real scripts.** Drop `typecheck` if you have none,
  rename scripts, etc. — keep it in sync with your `package.json` and `verify`.
- **No E2E?** Delete the `e2e` job.
- **Package manager / Node.** The workflow pins `pnpm 10` and Node 22; change both
  to match your project (or add a `packageManager` field to `package.json`).
- **Required checks.** In *Settings → Branches → branch protection*, add
  `typecheck`, `lint`, `test`, `build`, `e2e` as required status checks.
- **Merge method.** Squash-merging a PR that appends TRACE records orphans their provenance
  commits: in a fresh clone, or locally once the deleted branch's commits have been pruned
  (deleting the branch alone keeps them), `pnpm trace reaudit` reports those records as
  unreachable. Prefer a merge commit for such PRs.

---

## Multi-agent orchestration (Workflows)

The critic-bearing commands don't simulate critics in one context — they invoke
deterministic **`Workflow`-tool scripts** under `.claude/workflows/` that fan out
parallel subagents (own context each) with adversarial / maker-checker verification:
`critic-panel`, `scan-docs`, `gap-analysis`, `e2e-design`, `loop-iteration`,
`improve-skills` and `trace-bench`. Each registers as a skill under its `meta.name`, which
is its file name except for `improve-skills.js`: its skill name is `prompt-meta-critic`,
because a skill named like the `/improve-skills` command would be listed twice.

To adapt them:

- **They're project-aware via prompts, not config** — the agents read `CLAUDE.md`,
  the memory wiki, and your `src/`/`e2e/`/`docs/` paths. Adjust those paths in the
  scripts if your layout differs (e.g. a monorepo package dir).
- **Cost is real.** A critic round spawns ~10 critic agents + a verifier per blocker and
  per important finding up to a cap; `/multi-agent-dev` runs that twice (pre + post).
  That's the price of genuine independent review — scale the roster down if you want it
  lighter, or reserve the workflows for substantive changes. Hooks are not where the
  budget goes: a non-blocking command hook (such as the opt-in stop gate under *Optional
  hooks*) spends no model tokens, only local CPU and wall-clock time per firing, while one
  critic round or bench run spends millions of subagent tokens (the measured runs are in
  `.claude/memory/topics/workflow.md`). A hook that blocks, continues the turn or injects
  context does spend tokens, on every firing. Built-in bounds: a round
  verifies every blocker and fills the rest of its verifier cap (`args.maxVerifiers`,
  default 30) with important findings, round-robin across lenses, and records any beyond
  it as a `defer` (`counts.capDeferred`) instead of dropping it; `scan-docs` refuses more
  than `args.maxStories` (default 30) stories per call before any agent starts, so pass
  them in batches; `loop-iteration` likewise refuses more than `args.maxItems` (default 5)
  items per call; `improve-skills` is uncapped unless you pass `args.maxVerifiers`. With
  a `+Nk` token target, the workflows also stop at budget floors (output tokens left)
  instead of failing mid-run: `critic-panel` 80k before Review and 60k before Verify
  (and before the opt-in Coverage phase), `scan-docs` 60k, `gap-analysis` 40k, then 20k
  before each dimension's skeptic and before synthesis, `e2e-design` 20k before the
  judge, `improve-skills` 60k before Verify, `loop-iteration` 80k, `trace-bench` 60k.
  A round stopped at its start floor returns `error` and `budgetStopped`: it is
  incomplete, never clean.
- **Name workflows distinctly from commands** — a workflow whose `meta.name`
  matches a command shows up as a duplicate in the skills list (that's why the
  critic workflow is `critic-panel`, not `critic-round`, and `improve-skills.js`
  registers as `prompt-meta-critic`); `pnpm test` fails on a shared name.
- **Adding a workflow, or watching and resuming a run** — see `docs/workflow-graphs.md`:
  *Adding a workflow* is the checklist (when to promote a prototype, every registry entry
  `pnpm test` checks, the conventions the scripts share), and *Running, watching and
  resuming* covers the run journal and resuming after a limit or a kill with the saved args.
- **Requires a Claude Code build with the `Workflow` tool.** If yours lacks it, the
  commands still work as a single Lead agent simulating the panel — just without the
  independent contexts.

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
[ ] Copied .claude/commands/, .claude/workflows/, .claude/loop.md, loop-checklist.md,
    .claude/memory/, .claude/trace/, .claude/skills-index.md and scripts/trace/
[ ] Started .claude/memory/trace/ and quarantine.md EMPTY (no template records, no quarantine rows)
    and stripped the topic pages' <!-- rec:TR-… --> comments (pnpm trace wiki-check exits 0)
[ ] package.json has "trace": "node scripts/trace/cli.mjs"; unit-test globs include scripts/**/*.test.mjs
[ ] Copied docs/*.md and docs/stories/ story-map scaffolds (content cleared, formats kept)
[ ] CLAUDE.md "Main commands" point at my real scripts
[ ] verify trimmed to the scripts I actually have (no missing-script failure)
[ ] Package-manager + localhost URL/port updated to match my project
[ ] Monorepo: src/ , e2e/ , and port paths adjusted to my package layout
[ ] Merged .claude/settings.json into mine: allows only my real commands, denies kept;
    any git add/commit auto-allow lives only in my own .claude/settings.local.json
[ ] Optional: copied the opt-in Stop hook .claude/hooks/stop-gate.mjs + scripts/hooks/stop-gate.test.mjs
    (off until I add its snippet, see "Optional hooks"), or left both out
[ ] .gitignore covers .claude/settings.local.json and .claude/worktrees/; my linter ignores .claude/worktrees/**
[ ] CLAUDE.md memory @import path resolves from where my CLAUDE.md lives
[ ] Memory wiki: removed stack facts that don't apply (BEFORE first task); will re-seed via /dream
[ ] If a docs/ wiki already exists: namespaced the story map + picked ONE canonical
    memory home (see "Reconciling with an existing docs/ wiki")
[ ] Checked command name collisions; existing commands given descriptions + skills-index rows;
    disable-model-invocation only per the manual-only rule; old notes triaged (no secrets)
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
- **Permission prompts on every command.** The shared `.claude/settings.json` allow
  rules apply only after you accept the workspace trust dialog for the folder. Add the
  commands you trust: team-wide ones to `.claude/settings.json`, personal ones to your
  own `.claude/settings.local.json`.
- **The starter app fails after I changed the stack.** Remove the starter
  (`src/`, `e2e/`, build configs) once your own app and tests exist; it’s only a
  demonstration.
```
