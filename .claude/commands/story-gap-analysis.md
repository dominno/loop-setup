---
description: Read-only analysis of gaps between docs, implemented code, and E2E tests — a separate skeptic types each dimension's gaps, and the next implementation order is recommended over the licensed gaps only. Use when assessing MVP readiness or deciding what to build/test next.
argument-hint: [scope, e.g. "MVP readiness"] [completeness — adds the catch-all dimension]
---

Analyze the gap between product documentation, implemented code, and E2E tests.

Scope:
$ARGUMENTS

Before analyzing, consult the memory wiki: read `.claude/memory/index.md` and open
the topic pages relevant to the gaps you're assessing (e.g. `topics/testing.md`,
`topics/build-and-verify.md`) so "tested / not tested" and "edge cases" judgments
reflect the project's real conventions.

**Run the analysis as a deterministic multi-agent Workflow** — invoke the Workflow
tool with `scriptPath: .claude/workflows/gap-analysis.js`,
`args: { "scope": "$ARGUMENTS" }`. One finder agent analyzes each gap dimension in its
own context, in parallel. Then a separate skeptic agent per non-empty dimension tries to
refute each of its gaps and returns one typed verdict per gap (a TRACE verdict held to the
evidence gate), so the agents that propose a gap never license it. A final agent
synthesizes the recommended order over the licensed (`accept`/`qualify`) gaps only.
(Invoking Workflow here is expected.)
- The gate settles each gap under its dimension's claim type (`factual`; `predictive` for
  `ux-design`) and the skeptic's, keeping the stricter: a `factual` gap's `accept` or
  `qualify` citing only `reading` becomes `defer`, and a `ux-design` gap not observed in
  the browser or by a human is licensed at most as `qualify`. The skeptic is told an
  absence ("no test", "not documented") counts only through the search it ran and its
  empty result; the gate checks only the evidence kind, not that the search was run or
  came back empty.
- **Opt-in catch-all:** when the scope asks for a completeness pass (e.g. it ends with
  `completeness`), drop that word from the scope and add `"completeness": true` to the
  args. It adds an `other` dimension for gaps none of the seven covers, facing the same
  skeptic and gate: one more finder and skeptic per run, so it is off by default.

The workflow returns `{ error?, scope, totalGaps, licensedGaps, byDimension, deferred, rejected, failedDimensions, recommendedOrder, missing, verdictCounts }`
and no `traceRecords`: the verdicts are advisory and change no durable state. It covers:

1. Requirements found in docs but not implemented (`docs-not-impl`).
2. Implemented features not described in docs (`impl-not-docs`).
3. Stories implemented but not unit-tested (`impl-not-unit`).
4. Stories implemented but not E2E-tested (`impl-not-e2e`).
5. Stories E2E-tested but missing important edge cases (`e2e-missing-edges`).
6. Stories that work but fail UX/design/artistic-direction review (`ux-design`).
7. Ambiguous or contradictory requirements (`ambiguous`).
8. With `completeness: true`: any other gap (`other`).
9. Recommended next implementation order over the licensed gaps (`recommendedOrder`).

`byDimension` lists every analysed gap with its `id` (`<dimension>#<n>`), `verdict`,
`qualifier`, `missing`, `repair` and `evidenceChecked`; `deferred` and `rejected` list those
gaps across dimensions, each naming its `dimension`.

Render first:
- `error` if set (every dimension failed — infra; nothing was analysed, so re-run);
- then any `failedDimensions` (those dimensions were not analysed — never read their
  absence from `byDimension` as "no gaps");
- then `verdictCounts`. Every gap accepted means the skeptics changed nothing: check a
  sample of their evidence before you rely on the run. Every gap rejected: check a sample
  of the skeptics' reasons;
- a `recommendedOrder` of `null` means no order was synthesized: show its `missing`. If
  licensed gaps exist (the synthesizer failed, or the token budget floor skipped it), list
  them unordered; if none is licensed, no order can be made until the deferred and revised
  gaps are settled.

Then render the recommended order and the licensed gaps by dimension, each `qualify` gap
with its `qualifier`. The synthesizer is told to cite in each item's `why` the ids of the
gaps it addresses, but no code checks that it did: check each item, and flag any ordered
item that cites no licensed gap id (nothing traces it to a licensed gap). Then list the
gaps that are not licensed, which no order covers:
- every `deferred` gap with its `missing`: it is unverified, not refuted. `agent-failed` in
  its `failedGates` is an infra failure (re-run); `not-verified:budget` means no skeptic
  started below the token budget floor (re-run with a larger budget); for the rest, supply
  the missing evidence and re-run;
- every gap with verdict `revise` and its `repair`: a restated gap, not licensed until a
  re-run adjudicates it;
- every `rejected` gap, one line each: its `id` and the skeptic's `reason` (refuted).

Act only on licensed gaps. Do not edit files unless explicitly asked.
