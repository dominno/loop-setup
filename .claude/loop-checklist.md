# Loop readiness checklist

Ship-rubric for any recurring `/loop` before you raise its trust level. Adapted for
this repo from the "loop engineering" loop-design checklist
(https://github.com/cobusgreyling/loop-engineering). Pair with `.claude/loop.md`.

## Trust levels (what the loop may DO)
| Level | Scope | Requires |
|---|---|---|
| **L0 — Draft** | Intent documented | §1 |
| **L1 — Report** | Triage → run-log, no code changes | §1–3, §5 |
| **L2 — Assisted** | Small in-scope fixes + verifier; no auto-merge | §1–7 |
| **L3 — Unattended** | Acts without a human watching | all sections |

## Checklist
**1. Purpose & scope**
- [ ] Single clear goal (one sentence) + explicit non-goals
- [ ] Watched scope defined (repos, branches, PRs, tickets, paths)
- [ ] Phased-rollout plan (report-only before acting)

**2. Scheduling**
- [ ] Cadence matches urgency; off-hours behavior defined
- [ ] First-run + restart-durability behavior specified
- [ ] Self-stops when the watchlist empties

**3. Skills**
- [ ] Triage step has a tight output format
- [ ] Action steps match project conventions; build/test commands known

**4. Maker/checker split**
- [ ] Implementer and verifier are separate passes
- [ ] Implementer cannot mark its own work "done"
- [ ] Verifier runs tests in isolation before approving
- [ ] Verifier returns a **typed TRACE verdict** (accept/qualify/revise/defer/reject); a
      missing verdict defers — never confirms, never counts as a refutation

**5. State / memory**
- [ ] Run state documented (`.claude/memory/loop-run-log.md`)
- [ ] Prior state read at every iteration start
- [ ] Outcomes + timestamps appended to the run-log (append-only — never pruned there);
      resolved *plan nodes* pruned only in `loop-plan.md`; human overrides recorded
- [ ] Durable **plan/DAG** (`.claude/memory/loop-plan.md`) read at iteration start; every
      L2/L3 action traces to a **ready node** (no action without a node)
- [ ] **Re-plan is an explicit step run before dispatch**; the empty/first-iteration plan
      bootstraps a node rather than deadlocking
- [ ] **No durable state change without a record:** every node status change cites a
      TRACE-lite record (`done` = accept/qualify + `CLEAR`); `deferred`/`escalated` nodes
      name their `missing`; `pnpm trace lint` passes

**6. Human handoff**
- [ ] Escalation triggers explicit (max attempts, risk paths, ambiguity)
- [ ] Denylist paths identified (auth, payments, secrets, infra, CI config, migrations)
- [ ] Notify only when action is needed

**7. Connectors (MCP)**
- [ ] Minimum permissions; bot identity clear on comments
- [ ] Loop may open/update PRs or tickets only if acting (L2+)

**8. Cost & limits**
- [ ] Token/turn budget estimated; per-run cap + kill switch
- [ ] Append-only run log; remaining budget checked each iteration (against the per-run cap)
- [ ] Max iterations per item per run; max auto-PRs per day

**9. Observability**
- [ ] Each iteration logged (started, items found, actions, escalations)
- [ ] Success metric chosen; state inspectable without reading chat logs
      (`pnpm trace query` / `pnpm trace metrics` — consumer coverage, defer quality,
      repeated-error rate)

**10. Safety**
- [ ] No auto-merge without an explicit allowlist
- [ ] Secrets/env in denylist
- [ ] Flakes handled by root-cause, not retry-only
- [ ] **Measured checker (L3 only):** a recent `/trace-bench` run shows the loop
      verifier's WrongAcceptRate = 0 on bad fixtures the denylist does not catch (F4) and
      procedural invariance ≥ 0.8 (F3) — see `.claude/memory/topics/trace.md`

## Red flags (stop & fix before raising the level)
- Same PR/issue with >3 automated fix attempts without progress.
- Verifier is the same session as the implementer.
- No run-log (memory loss each iteration).
- Notifications on every run regardless of findings.
- Auto-merge without a path allowlist.
