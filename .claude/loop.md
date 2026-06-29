You are running a recurring multi-agent development watchdog loop for this localhost web app.

This loop is **hardened with "loop engineering" operating rules** (trust levels,
budget, denylist, escalation, stop conditions). Before running, fix the loop's
**trust level** and stay within it.

## Trust level (declare it before the first iteration)
- **L1 — Report only.** Triage and report findings; make NO code changes, commits,
  or PRs. The default when the level is unstated.
- **L2 — Assisted.** May apply small, in-scope, low-risk fixes with a verifier
  (post-implementation critic) confirming; never auto-merge.
- **L3 — Unattended.** May act without a human watching; requires every section of
  `.claude/loop-checklist.md` to be satisfied first.

## Per-iteration process (act as Lead Agent)
1. **Read state first:** open `.claude/memory/loop-run-log.md` (prior iterations,
   outcomes, human overrides) and check **remaining budget** against the per-run cap
   (turns or tokens — see *Budget & limits*) before doing anything; stop and
   escalate if it is already exhausted.
2. Identify the current active task from the conversation.
3. Check git status and changed files.
4. Start or reuse the dev server.
5. Open the relevant localhost page in Chrome or Playwright MCP.
6. Check browser console errors and failed network requests.
7. Run the critic round as the **critic-panel Workflow**
   (`.claude/workflows/critic-panel.js`, `args.focus` = the current task/flow):
   critics fan out as parallel subagents and findings are adversarially verified.
   Render the returned `confirmed` matrix.
8. **Maker/checker:** the pass that verifies a fix must be *separate* from the one
   that made it — the implementer never marks its own work "done".
9. Act **only within the trust level**:
   - L1: record findings only.
   - L2/L3: fix the confirmed blockers + directly-related important findings via the
     **loop-iteration Workflow** (`.claude/workflows/loop-iteration.js`,
     `args.items` = the triaged, denylist-cleared items): an implementer subagent
     fixes each in an isolated worktree and a *separate* verifier reviews the real
     diff and approves/rejects (a hard denylist gate also forces escalation). For
     each **approved** item, apply its returned `diff` patch and re-run the smallest
     relevant check before committing; escalate `rejected`/`escalate` items. Never
     fix nice-to-haves automatically; never start unrelated refactors.
10. **Append a run entry** to `.claude/memory/loop-run-log.md` (see format below).

## Denylist — never touch autonomously (escalate instead)
Auth, payments, secrets/`.env`, infrastructure/deploy, CI workflow config, and
database migrations. Also: do not push, deploy, delete data, modify secrets, or
auto-merge without an explicit allowlist.

## Escalate to a human (pause and ask) when
- A fix would touch a denylist path.
- An item hits the **max attempts** (see red flags) without progress.
- The right fix is ambiguous or architecturally significant (use AskUserQuestion).
- The budget is exhausted.
Notify only when action is needed — do not ping on a no-op run.

## Red-flag stop conditions (halt and escalate)
- The same issue/PR has **>3 fix attempts** without forward progress.
- The verifier is the same pass/session as the implementer.
- There is no run-log/state (memory loss between runs).
- You'd notify on every run regardless of findings.
- Auto-merge is enabled without a path allowlist.

## Budget & limits
- Declare a **per-run cap** with the trust level — a turn budget (e.g. 25 turns) or
  a token ceiling — and record remaining budget in every run-log entry; stop and
  escalate when reached.
- Max iterations per item per run: small (e.g. 3). Max auto-PRs per day: small.
- A loop with an empty watchlist should self-stop, not spin.

## Stop when
- No blockers remain, browser verification passes, relevant tests pass, and the
  current task has clear evidence of completion — or a stop condition above fires.

## Run-log entry (append to `.claude/memory/loop-run-log.md`)
```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- budget: <used>/<cap> (turns or tokens)
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Each loop report must include: current task, trust level, localhost status, critic
matrix, fixes applied, browser evidence, test evidence, escalations, and remaining risks.
