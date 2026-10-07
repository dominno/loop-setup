---
description: Measure this project's own checkers with TRACE-Bench-lite — run the trace-bench Workflow over seeded-defect fixtures (loop verifier, single-pass reviewer, optional critic panel), score it deterministically, and report WrongAcceptRate, invariance, the external-judge gap and the pre-registered falsification flags. Use before raising a loop to L3, or after changing a checker prompt.
argument-hint: [arms, e.g. "verifier,single-pass" | "panel" — default verifier,single-pass] [repeat N]
disable-model-invocation: true
---

Run **TRACE-Bench-lite**: measure whether our checkers actually catch what they claim
to, instead of assuming it. This is the measurement side of the TRACE-lite contract
(`.claude/memory/topics/trace.md` → *Measurement & pre-registered falsification*).

Arguments:
$ARGUMENTS

## Procedure
1. **Check the fixtures still describe reality:** `pnpm trace bench-judge --skip-e2e`
   (add the e2e ones when localhost port 3000 is free: plain `pnpm trace bench-judge`).
   Every row must be `ok: true` — a fixture whose deterministic judge no longer behaves
   as the manifest says is stale; fix the manifest before benchmarking.
2. **Build the workflow args** (fixtures carry only the work item + patch; the ground
   truth never reaches the agents):
   `pnpm -s trace bench-args --arms <arms> --repeat <N>` → save to a scratch file.
   Default arms `verifier,single-pass`, repeat `2` (repeat ≥ 2 is needed for the
   procedural-invariance metric). `panel` adds one agent per critic per fixture (~10×
   fixtures) — run it deliberately, optionally with `--critics a,b`.
3. **Run the Workflow** — `scriptPath: .claude/workflows/trace-bench.js`, `args` = the
   step-2 JSON. This command opts into multi-agent orchestration (it spawns
   fixtures × repeat verifier agents + fixtures single-pass agents); invoking Workflow
   here is expected. Save the returned object to
   `.claude/trace/bench/runs/<YYYY-MM-DD>-<arms>.json`.
4. **Score it:** `pnpm trace bench-score .claude/trace/bench/runs/<file>.json --record`
   — prints the metrics and appends a `measured` TRACE record (`claim_id
   bench:trace-bench-lite`, revising the previous run's record).
5. **Report** a table per arm (WrongAcceptRate, FalseHoldRate, defer rate, gate
   downgrades, invariance; single-pass vs panel recall / false-block; n_eff), the
   external-judge gap (`judgeOnly` / `agentOnly` / `both` / `neither` — `agentOnly` is
   what the agent checkers add beyond tests; `neither` is undefended ground), and every
   fired flag (F1–F5) with what it means for the design. Don't explain a flag away
   after the fact — they are pre-registered.
6. If a flag fires, propose (don't apply) the response: F1 → shrink the fan-out; F3 →
   don't trust single-run verdicts / raise repeat; F4 → keep loops at ≤ L2 and tighten
   the verifier via `/improve-skills`. Then run `/dream` to file any durable lesson.

## Notes
- The verifier arm runs the **exact** production `loop-iteration` checker (prompt,
  schema, evidence gate and denylist are byte-identical copies — `pnpm test` fails on
  drift), with `checksPassed` self-reported as true for every fixture (worst case: the
  checker must not lean on the implementer's word).
- Adding a fixture: a `B..`/`G..` entry in `.claude/trace/bench/fixtures.json` + a patch
  in `patches/` (generate it with `git diff` from a clean tree); `pnpm test` checks that
  it applies and that its judge kind matches the denylist; `bench-judge` checks the rest.
