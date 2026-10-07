# TRACE-lite — typed verdicts, records, and the "no durable change without a record" rule

Adapted from Chang & Chang, *TRACE: An Operational Reasoning Schema for Auditable Agentic
Commitments* (arXiv:2607.12480, preprint). The paper's unit of contribution is **the
record, not any stage algorithm**: every adjudicated claim gets a typed, versioned,
append-only record carrying its verdict, evidence, failed gates, missing evidence and
repair; consumers act only on records. We adopt that **contract** for our own machinery
(critic verdicts, loop dispatch, memory admission, story status) — not the paper's
8-stage writer or argumentation-theory apparatus. Records measure compliance with *this*
declared policy, **not** objective truth: gates verify field consistency, not field
truth (paper §7.2).

<!-- trace-policy-version: 1 -->
(machine-readable; `scripts/trace/lib.mjs` stamps it on every record and refuses records
written under a newer policy — bump it whenever the tables below change.)

- Schema: `.claude/trace/schema-v1.json` · Store: `.claude/memory/trace/records.jsonl`
  (append-only JSONL, archives `<YYYY>.jsonl`) · Writer/linter: `pnpm trace …`
  (`scripts/trace/cli.mjs`). Never hand-edit the store; corrections are new records that
  `revises` the old one.

## Verdicts (`final_status`)
| verdict | meaning | licenses action? | required field |
|---|---|---|---|
| `accept` | holds as stated, at the evidence standard of its claim type | yes | evidence of an accepted kind (table below) |
| `qualify` | holds, but only at a weaker strength | yes (with the qualifier) | `qualifier` |
| `revise` | does not hold as stated; a restated claim/fix might | no | `repair` |
| `defer` | cannot be settled with the evidence available | no | non-empty `missing` (what would settle it) |
| `reject` | refuted | no | `reason` |

A missing/unknown verdict from a checker is **`defer`** (missing: "a verdict"), never
accept and never reject — an unreadable verdict is neither evidence for nor against.

## Evidence standard per claim type (the evidence gate)
A checker's `accept` is downgraded deterministically when its cited evidence is weaker
than the claim type demands (TRACE's rung discipline, generalized: *no claim stronger
than its evidence*). `reading` (code reading without a reproducible pointer) never
satisfies `accept`.

| claim_type | example | accept needs evidence kind | on fail |
|---|---|---|---|
| factual | "the input has no label" | file_line, command, browser, measurement, diff | defer |
| measured | "contrast is 3.1:1", "bundle is over budget" | measurement | defer |
| causal | "this change causes a regression" | command, browser, measurement | qualify |
| predictive | "first-time users will miss the button" | browser, human | qualify |
| normative | "this violates the DRY rule in CLAUDE.md" | rule, human | defer |
| practical | "apply this diff" (loop-iteration, improve-skills edits) | diff | defer |

The canonical code is the `<trace-evidence-gate>` block in `scripts/trace/lib.mjs`;
workflows inline a byte-identical copy (they cannot import) and `scripts/trace/lib.test.mjs`
fails on drift — including drift between this table and the code.

## Consumer actions (record-consumer contract)
| action | allowed on | used by |
|---|---|---|
| CLEAR | accept, qualify | loop (node → done), multi-agent-dev / qa-pass (finding fixed), improve-skills (edit applied) |
| COMMIT | accept | dream (fact filed) |
| COMMIT_QUALIFIED | accept, qualify | dream (fact filed with its qualifier) |
| QUARANTINE | qualify, revise, defer | dream (held in `.claude/memory/quarantine.md` until `missing` arrives) |
| HOLD | any | loop (node deferred/escalated), any consumer withholding |
| REJECT | any | dream (not filed), improve-skills (edit declined) |
| REUSE | any | critic-panel (prior verdict reused on an identical working tree — `pnpm trace tree-id`) |
| REAUDIT | any | dream lint (evidence file changed since the record's commit) |

**Fail closed:** CLEAR/COMMIT/COMMIT_QUALIFIED are refused on a non-licensing verdict and
on a superseded record (act on the latest revision). **Authority separation:** a verdict
is advice about *warrant*, not a grant of *authority* — a consumer may HOLD an accepted
claim (e.g. a denylist path still needs a human).

## The discipline — no durable state change without a record
| boundary | record writer | consumer action |
|---|---|---|
| loop-plan node → `done` / `deferred` / `escalated` | `loop-iteration` (+ Lead for post-apply checks) | CLEAR / HOLD |
| fact → memory wiki (`/dream ingest`) | `dream` (Lead) | COMMIT / COMMIT_QUALIFIED / QUARANTINE / REJECT |
| story status change (`/scan-project-docs`, `/sync-story-status`) | `scan-docs` | COMMIT |
| critic finding acted on (`/multi-agent-dev`, `/qa-pass`, `/loop`) | `critic-panel` | CLEAR (fixed) / HOLD |
| prompt edit applied (`/improve-skills`) | `improve-skills` | CLEAR / REJECT |

Read-only rounds (`/critic-round`) still write their verdict records (memory, not code) —
that is what verdict reuse reads. `gap-analysis` and `e2e-design` write no records: they
propose, they do not adjudicate, and no durable state changes on their output.

## Record guarantees ↔ how this repo enforces them
- **Immutability** — append-only store; duplicate ids rejected; corrections via `revises`.
- **Version legibility** — `schema_version` const + `policy_version` stamp; a reader refuses
  records from a newer policy (`pnpm trace lint`).
- **Self-containment** — verdict, failed gates, missing, repair live in the record.
- **Provenance** — `writer_id` + `provenance.commit/workflow`; the writer fails closed
  without a commit.
- **Integrity gate in CI** — a vitest test replays the committed store (`pnpm test`).

## Debate-ness (D1–D4) of our critic panel, and the consensus rule
D1 role separation ✓ (own contexts) · D2 objective opposition ✓ (skeptic refutes) ·
D3 epistemic diversity ~ (Sonnet critics vs Opus verifier only) · D4 external adjudication
partial (verifier is an LLM; the deterministic bars — tests, axe, bundle budget, denylist —
are the real external judges). Because every critic is the same model, **agreement between
critics is weak evidence** (Prop. 4: n_eff = n/(1+(n−1)ρ̄) → 1 as ρ̄ → 1). `critic-panel`
therefore counts corroboration only when another critic brings *different* evidence, and
passes that evidence to the verifier; agreement alone never upgrades a finding.

## Stop conditions (paper §5.4) — used by `/loop` and `/multi-agent-dev`
Stop when every claim is (1) a qualified proposal (accept/qualify, acted on), (2) rejected,
(3) deferred with named `missing`, or (4) **diminishing returns**: a re-run produced no new
evidence (no new record, no verdict change) — report the defers instead of spinning.

## Measurement & pre-registered falsification (TRACE-Bench-lite)
`/bench-checkers` runs `.claude/workflows/trace-bench.js` over seeded-defect fixtures
(`.claude/trace/bench/`); `pnpm trace bench-score` scores it; `pnpm trace metrics` scores
the live store. Pre-registered — results that count **against** our design:
- **F1** single-pass reviewer matches/beats the critic panel on recall and false-block
  rate → the fan-out is unjustified on this bench.
- **F2** the evidence gate never changes a verdict → it is decorative (informational).
- **F3** procedural invariance < 0.8 across identical re-runs → single-run verdicts are noise.
- **F4** WrongAcceptRate of the loop verifier > 0 on bad fixtures not caught by the
  denylist → the checker licenses bad diffs; tighten before raising a loop above L2.
- **F5** store `consumerCoverage` < 0.5 after real use → records are an archive, not an
  instrument; cut fields.
- **F0** (validity precondition) any bench agent's transcript contains ground truth →
  those runs are excluded; a run with F0 is not a clean measurement.

**Contamination rule (learned the hard way — the first bench run was contaminated):**
bench agents run inside this repo and grep it, so fixture ground truth must never be
plain text in the tree. Fixtures live gzip+base64-encoded in
`.claude/trace/bench/fixtures.bundle`; agents get opaque `fx-…` tokens, never real ids;
raw runs stay in the scratchpad (their verdict prose names the defects); bench records
carry counts only; a unit test scans the whole tree for leaked ids/defect text; and
`bench-score --transcripts` excludes any run whose agent saw ground truth anyway.

## Not adopted (deliberately)
The 8-stage reference writer and formulation gate (our inputs are diffs/flows, not
narrative text); the full 10-family taxonomy, ~60 Walton schemes and Dung semantics (5+1
claim types and 2–4 critical questions per critic lens suffice); Pearl do-calculus/bounds;
the `RecordUtility` scalar as a target (Goodhart — the paper says report-only); a separate
debate stage (critic panel + skeptic already is one).

## Gotchas
- Workflow scripts cannot `import`; shared deterministic blocks (`<trace-evidence-gate>`,
  `<loop-denylist>`) are duplicated byte-for-byte and parity-tested — edit the canonical
  copy, paste into every marked block, run `pnpm test`.
- The store lives under `.claude/`, which the `loop-iteration` denylist already blocks for
  implementer diffs — records are written only by checkers/the Lead via `pnpm trace`.
- `claim_id` must be stable across rounds for reuse/recurrence metrics to work; critics set
  `revisits: <record_id>` when re-raising a prior claim so the chain is kept.

Related: [workflow](./workflow.md) · [quality-bar](./quality-bar.md) · [testing](./testing.md)
