# Project Instructions for Claude Code

## Loop-setup kit (installed in `~/.claude`, not part of this project)
This project uses the **loop-setup kit**: multi-agent critic workflows, TRACE-lite records, a
memory wiki and hardened loops. The kit is installed in `~/.claude/loop-setup/` (`loop-setup
install`), not in this repository. Its rules are injected into every session by the kit's
SessionStart hook; the full text is `~/.claude/loop-setup/kit/rules/KIT.md` (`loop-setup where`).

- The loop state (wiki, records, plan, run log) lives in this project's workspace
  `~/.claude/loop-setup/workspaces/<id>/`. It is reached here as `.claude/loop-workspace/`, a
  git-ignored link, and persisted on the `claude/loop-state` branch with `loop-setup sync`.
- This repository is also the kit's **source**: `kit/`, released by tagging. Install or upgrade
  it from the committed tree with `node kit/bin/loop-setup.mjs install --from .`. Loops never
  edit `kit/`; it is on the denylist.
- No kit installed (a teammate, CI)? The project still builds and tests normally; the rules
  below still apply.

## Project type
This is a local web application developed and tested on localhost.

## Package manager
Use pnpm unless package-lock.json exists. Do not switch package managers.

## Main commands
- Start dev server: `pnpm dev`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Unit tests: `pnpm test`
- E2E tests: `pnpm test:e2e`
- Production build: `pnpm build`
- Full verification: `pnpm verify`

## Localhost
Default app URL: `http://localhost:3000`.

Before browser testing:
1. Check if the dev server is already running.
2. If not running, start it in the background. This is for the Lead session only:
   workflow subagents never start, stop or kill servers, and they report a down
   localhost as missing evidence.
3. Wait until localhost responds.
4. Only then use Chrome or Playwright MCP.

## Design principles
Every development change follows these. When they pull in different directions, this is the
priority order: **hexagonal architecture** first (it decides where code lives and which way
dependencies point), then **SOLID**, then **KISS**, then **DRY**. Every change is built test-first
(**TDD**). They govern new and changed code; never restructure unrelated code just to comply
(*Scope control* still applies).

### 1. Hexagonal architecture (ports and adapters) — the default for all new and changed code
- **The core** (domain rules and use cases) sits in the middle and is plain TypeScript. It
  imports no React, Next.js, DOM, `fetch`, storage, environment variables, clock or randomness.
- **Ports** are interfaces the core owns. A driving port is a use case the outside world calls.
  A driven port is something the core needs from outside: storage, an HTTP API, the current time.
- **Adapters** live at the edge. **Driving adapters** call the core: React components, Next.js
  routes and API handlers. **Driven adapters** implement a driven port: `localStorage`, `fetch`,
  a database.
- **The dependency rule:** adapters depend on the core, never the reverse. The core never imports
  an adapter or a framework. Adapters are wired to ports at the edge (a route, a hook, a
  composition module).
- **In this repo:**
  - domain logic lives in `src/lib`, and `src/lib/greeting.ts` is a pure core;
  - `src/app` routes and `src/components` are driving adapters;
  - `src/lib/rememberedName.ts` is a driven adapter for `localStorage` that has no port yet.
    Give it one when a task changes it, never as a standalone refactor.
- **Keep it proportional (KISS):** a pure function with no I/O is already core and needs no port.
  Add a port only where the core would otherwise touch I/O, a framework, or something
  nondeterministic.
- **What it buys:**
  - The core is tested fast and directly, with no framework mocks.
  - Each adapter is tested once against the real thing.
  - Infrastructure can change (localStorage → a server, one API → another) without touching
    business rules.
  - Framework upgrades stay inside the adapters.
  - Review has one checkable rule: does the core import infrastructure?
  - Agents and people can work in parallel on different adapters without colliding.

### 2. SOLID
- **S — single responsibility:** a module has one reason to change. What it buys: small diffs,
  focused tests, clear ownership.
- **O — open/closed:** extend behaviour with a new adapter or strategy instead of editing working
  core code. What it buys: new features cause fewer regressions.
- **L — Liskov substitution:** any implementation that honours a port's contract can replace
  another. What it buys: adapters are swappable, and tests can use in-memory fakes that behave
  like the real thing.
- **I — interface segregation:** ports are small and specific. What it buys: an adapter implements
  only what it needs, and a change to one port does not ripple through unrelated code.
- **D — dependency inversion:** the core depends on abstractions (ports), not concrete
  infrastructure. What it buys: this is the rule that makes hexagonal architecture work.

### 3. KISS — keep it simple
The simplest code that passes the tests and reads clearly wins. No speculative abstraction, no
configuration nobody asked for, no cleverness that needs a comment to explain it. What it buys:
fewer bugs, faster review, and code the next person or agent understands on the first read.

### 4. DRY — don't repeat yourself
Every piece of knowledge has one source of truth: a business rule, a constant, a schema, a storage
key. DRY is about knowledge, not similar-looking lines: prefer a little duplication over coupling
two unrelated things, and extract on the third real repeat. What it buys: a fix lands once, and
copies never drift apart.

### 5. TDD
Write a failing test first, make it pass with the smallest change, then refactor. What it buys:
proof that the test catches the bug, a safety net for refactoring, and a design that stays
testable, which hexagonal boundaries make easy.

## Development rules
- Follow the design principles (see *Design principles*): hexagonal architecture first, then
  SOLID, KISS and DRY, all built test-first (TDD). A change that makes the core import
  infrastructure, or skips a port where the core would touch I/O, is an important finding, not a
  nice-to-have.
- Prefer small, focused changes.
- Do not rewrite large unrelated areas.
- Do not change public APIs unless the task explicitly requires it.
- Do not hide failing tests.
- Do not delete tests to make the suite pass.
- Do not weaken or delete an assertion to make a check pass. If you change a test's
  expectation, state in your report why the old expectation was wrong (the root cause).
- Mocks don't prove integration. A behaviour whose only tests mock or stub what it
  integrates with (`vi.mock`, `vi.stubGlobal`, spies) counts as unit-tested only. Pair
  it with a test on the real stack (a Playwright spec for user flows; otherwise an
  integration test against the real module, route or CLI, like `tempRepo()` in
  `kit/trace/cli.test.mjs`), or name the gap and why under Remaining risks. This
  rule governs how coverage is reported and how story status is classified, not
  whether a diff that adds a stubbed unit test is acceptable.
- Always explain root cause before applying a fix.
- After fixing, run the smallest relevant test first, then the full verification command.
- Fix attempts are bounded, counted per failing check within one task (separate from
  `/multi-agent-dev`'s 3-round cap and `/loop`'s per-item cap). If the same check fails
  with the same error twice in a row, stop patching and re-diagnose from the raw output.
  A fresh `Agent` subagent given only the failing command, its output and the diff is a
  good second opinion; its fix is a claim you re-run, not evidence. After 5 failed
  attempts, stop and report the blocker: the command, the exact error, what you tried,
  and your best root-cause hypothesis. The task stays incomplete.
- Commit or push only when the user explicitly asks, never as a side effect of
  completing a task. An allow rule for `git commit`, wherever it is configured, is a
  convenience, not a license. If on the default branch, branch first.
  Commit by pathspec, because other agents and sessions share this checkout:
  `git add -- <new files>` first (an untracked path is not matched), check with
  `git commit --dry-run --short -- <paths>`, then `git commit -m "…" -- <paths>`; never
  `git add -A` or `git commit -a`. Exception: a pathspec commit re-adds a file you
  untracked with `git rm --cached` while it is still on disk, so commit that change
  from the index after `git diff --cached --name-status` lists only your paths.
  Never rewrite pushed history (no amend, rebase or force-push of pushed commits);
  fix forward, because TRACE records cite commit SHAs.

