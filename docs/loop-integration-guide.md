# Integrating hardened recurring loops into an existing project

A practical guide to adding safe, recurring `/loop` automations ("loop
engineering") to a project that already uses this template's workflow. Adapted from
[cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering).

> **A loop is a recurring goal:** an agent iterates toward an objective on a cadence
> (triage → act → verify → record), escalating to a human when needed. The risk is
> the same project's caveat — *unattended loops make unattended mistakes and token
> costs explode* — so a loop is only as safe as its operating rules.

**Prerequisite:** you've adopted the base workflow (see
[`adoption-guide.md`](./adoption-guide.md)). This guide adds the *recurring-loop*
layer on top.

---

## 1. What you're adding (copy these)

```txt
.claude/loop.md                    Hardened loop operating prompt (trust levels, denylist, stop rules, run-log step)
.claude/loop-checklist.md          Readiness rubric to promote a loop's trust level (L0→L3)
.claude/memory/loop-run-log.md     Durable, append-only loop run state
.claude/memory/loop-plan.md        The plan/DAG every L2/L3 action traces to (incl. the `deferred` status)
.claude/memory/trace/records.jsonl TRACE-lite record store — start it empty; written only via `pnpm trace`
.claude/memory/topics/trace.md     The record policy: typed verdicts, evidence gate, consumer actions
scripts/trace/  .claude/trace/     The `pnpm trace` CLI/tests + schema (and bench fixtures for /bench-checkers)
```

A node only becomes `done` with an `accept`/`qualify` record and a `CLEAR` action; a
`defer` verdict parks it as `deferred` with the `missing` evidence named, so a hold is
resolvable rather than a dead end. Before promoting a loop to L3, run `/bench-checkers`
and clear checklist §10's measured-checker item.

Then merge the loop paragraph from this template's `CLAUDE.md` ("Writing `/goal` and
`/loop` prompts" → the trust-level + maker/checker note) into your `CLAUDE.md`.

## 2. The operating model in one breath

Declare a **trust level** and stay inside it; keep **durable state** in the run-log;
obey a **denylist**, **escalation triggers**, **red-flag stop conditions**, and a
**budget cap**; and keep the **verifier separate from the implementer** (no
self-approve).

| Level | The loop may… | Promote only when |
|---|---|---|
| **L1 — Report** | triage → write the run-log; **no** code changes | checklist §1–3, §5 |
| **L2 — Assisted** | small in-scope fixes with a verifier; **no** auto-merge | checklist §1–7 |
| **L3 — Unattended** | act without a human watching | **all** checklist sections |

## 3. Step-by-step

1. **Copy the three files** above; merge the `CLAUDE.md` loop guidance.
2. **Define purpose & scope** for the loop: one-sentence goal, explicit non-goals,
   and the watched scope (which repos, branches, PRs, tickets, paths). Fill §1 of
   `.claude/loop-checklist.md`.
3. **Set cadence & lifecycle:** an interval that matches urgency, first-run and
   restart behavior, off-hours behavior, and **self-stop when the watchlist empties**.
4. **Adapt the denylist to your repo:** keep auth, payments, secrets/`.env`,
   infra/deploy, CI config, and DB migrations off-limits; add anything
   project-specific. Adjust the localhost/command references to your stack.
5. **Set the budget & limits:** a **per-run cap** (turn budget, e.g. 25 turns, or a
   token ceiling), max iterations per item, max auto-PRs/day, and a kill switch.
   Record remaining budget in each run-log entry.
6. **Wire the state:** read `.claude/memory/loop-run-log.md` at the **start of each
   iteration** and append an entry at the **end of each iteration**; prune resolved
   items; record human overrides. (Rotates past 500 lines, like the memory log.)
7. **Start at L1 (report-only).** Run it, read the run-log, confirm it triages
   correctly and changes nothing. Notifications should fire **only** when action is
   needed — not every run.
8. **Promote to L2** only after checklist §1–7 pass: allow small, in-scope, low-risk
   fixes, each confirmed by a **separate verifier** pass (the implementer never
   marks its own work done); still no auto-merge.
9. **Promote to L3** only after **all** checklist sections pass and you trust it
   unattended. Re-read the red flags first.

## 4. Pick a loop pattern (recipes)

Common recurring loops — each is a `/loop` with its own scope, cadence, and budget:

| Pattern | What it does | Start at | Cadence |
|---|---|---|---|
| **Daily triage** | scan for issues/regressions, report | L1 | 1–2 h |
| **PR babysitter** | watch a PR's CI + reviews, fix red, re-push | L2 | 5–15 m |
| **CI sweeper** | keep `main` green | L2 | 5–15 m |
| **Dependency sweeper** | propose dep bumps with passing `verify` | L1→L2 | 6 h–1 d |
| **Changelog / post-merge cleanup / issue triage** | housekeeping | L1 | 1 d |

> In this template, **PR babysitter** is already available via
> `subscribe_pr_activity` + a scheduled self check-in — the same maker/checker +
> escalation rules apply.

## 5. Parallel / file-mutating loops → worktrees

If a loop (or its sub-agents) mutates files in parallel, run the **implementer via
`Agent` with `isolation: worktree`** so concurrent work can't clobber a shared tree,
and have the **verifier** run tests in its own isolation before approving.

## 6. Red flags — stop and fix before raising a level

- Same PR/issue with **>3 fix attempts** without progress.
- Verifier is the **same session** as the implementer.
- **No run-log** (memory loss between iterations).
- Notifications on **every** run regardless of findings.
- **Auto-merge** without a path allowlist.

## 7. Adapt to where the loop runs

- **Local / Claude Code on the web:** `/loop <interval>` drives `.claude/loop.md`;
  the run-log is the durable state across iterations.
- **CI / scheduled (GitHub Actions, cron):** the same operating rules apply; the
  run-log lives in the repo, and the denylist/budget/escalation must be explicit
  because no human is watching.

## 8. Before you call a loop "ready"

Run through [`.claude/loop-checklist.md`](../.claude/loop-checklist.md) and only
raise the trust level when its sections for that level pass. **When in doubt, stay
at L1** — report-only loops are almost always safe; acting loops are not.
