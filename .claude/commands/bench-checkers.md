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
1. **Check the fixtures still describe reality.** Preconditions: the files the fixtures
   patch have no local changes, and (for E2E judges) nothing is listening on port 3000.
   Run `pnpm trace bench-judge` (or `--skip-e2e` for a quick pass). It first runs every
   judge command on the clean tree (a judge that already fails there aborts the run),
   then refuses stale fixtures (patches that no longer apply). It refuses to start while
   a fixture patch is still applied from a killed run — `pnpm trace bench-judge --recover`
   reverses those. Ctrl+C / SIGTERM / SIGHUP stop it after the current patch is
   reversed. Every row must be
   `ok: true` — with `--skip-e2e`, the skipped E2E rows show `ok: null` and are the only
   acceptable exception. A row that is `ok: false` means the manifest is stale; fix it
   before benchmarking.
2. **Build the workflow args** (fixtures carry only the work item + patch; the ground
   truth never reaches the agents):
   `pnpm -s trace bench-args --arms <arms> --repeat <N>` → save to a scratch file.
   Default arms `verifier,single-pass`, repeat `2` (repeat ≥ 2 is needed for the
   procedural-invariance metric). `panel` adds one agent per critic per fixture (~10×
   fixtures) — run it deliberately, optionally with `--critics a,b`.
3. **Run the Workflow** — `scriptPath: .claude/workflows/trace-bench.js`, `args` = the
   step-2 JSON. This command opts into multi-agent orchestration (it spawns
   fixtures × repeat verifier agents + fixtures single-pass agents); invoking Workflow
   here is expected. Save the returned object to your **scratchpad**, never the repo —
   the verdict prose names the defects, and anything committed is greppable by the next
   run's agents.
4. **Score it:** `pnpm trace bench-score <scratch>/run.json --transcripts <the workflow's
   transcript dir> --record` — scans every agent transcript for leaked ground truth
   (fixture ids, defect text) and excludes those runs (**F0**), prints the metrics, and
   appends a counts-only `measured` TRACE record (`claim_id bench:trace-bench-lite`,
   revising the previous run's record). `--record` refuses to run without
   `--transcripts`: an unscanned run is not a measurement.
5. **Report** a table per arm (WrongAcceptRate, FalseHoldRate, defer rate, gate
   downgrades, invariance; single-pass vs panel recall / false-block; n_eff), the
   excluded runs (contaminated / no verdict), the external-judge gap (`judgeOnly` /
   `agentOnly` / `both` / `neither` — `agentOnly` is what the agent checkers add beyond
   tests; `neither` is undefended ground), and every fired flag with what it means for
   the design (`bench-score` emits F0–F4; F5 comes from `pnpm trace metrics`). Say which
   flags *could not* fire: F1 needs the `panel` arm, F3 needs `repeat ≥ 2`. Don't explain
   a flag away after the fact — they are pre-registered.
6. If a flag fires, propose (don't apply) the response: F1 → shrink the fan-out; F3 →
   don't trust single-run verdicts / raise repeat; F4 → keep loops at ≤ L2 and tighten
   the verifier via `/improve-skills`. Then run `/dream` to file any durable lesson.

## Notes
- The verifier arm runs the **exact** production `loop-iteration` checker (prompt,
  schema, evidence gate and denylist are byte-identical copies — `pnpm test` fails on
  drift), with `checksPassed` self-reported as true for every fixture (worst case: the
  checker must not lean on the implementer's word).
- Fixtures live **encoded** in `.claude/trace/bench/fixtures.bundle` (see that folder's
  README): agents grep this repo, so ground truth must never be plain text in it. Edit via
  `pnpm trace bench-unpack <dir-outside-repo>` → edit → `pnpm trace bench-pack <dir>`;
  `pnpm test` checks the bundle, that patches apply, judge kinds vs the denylist, and that
  no fixture id/defect text appears anywhere in the tree; `bench-judge` checks the rest.
- When reporting, describe fixtures by count and category, not by id — the report text
  may end up in the repo (log, records).
