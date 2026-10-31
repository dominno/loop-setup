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

<!-- trace-policy-version: 3 -->
(machine-readable; `scripts/trace/lib.mjs` stamps it on every record and refuses records
written under a newer policy — bump it whenever a table below or a record rule changes.)
v3 adds the memory write boundary for `wiki:` records (**Record guarantees**); records
written under v1/v2 replay unchanged.

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
Likewise a reviewer agent that dies is reported (`failedReviewers`), never read as "no
findings".

## Evidence standard per claim type (the evidence gate)
A checker's **licensing** verdict (`accept`, and since policy v2 also `qualify`) is
downgraded deterministically when its cited evidence is weaker than the claim type
demands (TRACE's rung discipline, generalized: *no claim stronger than its evidence*). A
checker cannot dodge the floor by self-demoting to `qualify`: only causal and predictive
claims, whose fallback *is* qualify, may qualify on weaker evidence. `reading` (code
reading without a reproducible pointer) never satisfies the floor. **Re-typing never
lowers the bar:** when the checker re-types the maker's claim, the gate runs under both
types and keeps the stricter outcome (`retyped_from` records the original type).

| claim_type | example | accept needs evidence kind | on fail |
|---|---|---|---|
| factual | "the input has no label" | file_line, command, browser, measurement, diff | defer |
| measured | "contrast is 3.1:1", "bundle is over budget" | measurement | defer |
| causal | "this change causes a regression" | command, browser, measurement | qualify |
| predictive | "first-time users will miss the button" | browser, human | qualify |
| normative | "this violates the DRY rule in CLAUDE.md" | rule, human | defer |
| practical | "apply this diff" (loop-iteration) | diff | defer |

The canonical code is the `<trace-evidence-gate>` block in `scripts/trace/lib.mjs`;
workflows inline a byte-identical copy (they cannot import) and `scripts/trace/lib.test.mjs`
fails on drift — including drift between this table and the code.

## Consumer actions (record-consumer contract)
| action | allowed on | used by |
|---|---|---|
| CLEAR | accept, qualify | loop (node → done), multi-agent-dev (finding fixed), improve-skills (edit applied) |
| COMMIT | accept | dream (fact filed) |
| COMMIT_QUALIFIED | accept, qualify | dream (fact filed with its qualifier) |
| QUARANTINE | qualify, revise, defer | dream (held in `.claude/memory/quarantine.md` until `missing` arrives) |
| HOLD | any | loop (node deferred/escalated), critic-round (review-only), any consumer withholding |
| REJECT | any | dream (not filed), improve-skills (edit declined) |
| REUSE | any | critic-panel (prior verdict reused on an identical working tree — `pnpm trace tree-id`) |
| REAUDIT | any | dream lint (evidence file changed since the record's commit, or that commit is unreachable) |

**Fail closed:** CLEAR/COMMIT/COMMIT_QUALIFIED are refused on a non-licensing verdict, on
a superseded record, and on any record that is no longer the newest for its `claim_id`
(act on the latest verdict). **Authority separation:** a verdict is advice about
*warrant*, not a grant of *authority* — a consumer may HOLD an accepted claim (e.g. a
denylist path still needs a human).

## Consumer protocol (every command follows this — don't restate it, cite it)
- **Writing a workflow's records:** save the workflow result JSON to a scratchpad file
  (Write tool), then `pnpm trace write <file>` (reads `traceRecords`) and, if present,
  `pnpm trace act --from <file>` (reads `reuseActions`). If the writer rejects a draft
  (`stored: false`), report the violations and act on **no** finding from that batch —
  never hand-edit a draft to force it through. `write --then-act ACTION --consumer NAME
  --note …` records one decision on every stored record (e.g. `HOLD` for a review-only round).
- **`accept`** → act. **`qualify`** → act only at the qualified strength and carry the
  qualifier forward (node notes, report, wiki bullet). Unattended (L3), only `accept` is
  auto-applied — `loop-iteration` itself returns an L3 `qualify` as `held` (enforced in
  code, not just prose); an omitted trust level is L1 and dispatches nothing.
- **`defer`** → never act. Resolve it by supplying the named `missing` evidence and
  re-adjudicating with a **separate** checker (re-run the workflow that produced it, with
  the evidence as `priorEvidence`); the new verdict is a new record that `revises` the
  defer, and you act on that. A defer whose `missing` is a human decision (denylist,
  ambiguity) is resolved only by that human.
- **`defer` with `agent-failed` in `failed_gates`** → an infra failure, not a verdict: the
  agent threw or returned nothing (token budget spent, a terminal API error, a skip), so
  nothing was weighed. Re-run the workflow that produced it; never wait for evidence and
  never count it as refuted. Many of them in one run is an outage: report it, and re-run
  once its cause is fixed.
- **`revise`** → the claim as stated is not licensed; its `repair` is a *new* claim —
  adjudicate it (new record that `revises`) before acting, or HOLD.
- **`reject`** → nothing to fix; HOLD/REJECT. In a plan node, `missing` becomes
  "a human decision on: <reason>".
- **"Fixed"** = a `CLEAR` on the finding's latest licensing record, written only after the
  separate checker (post-implementation round / loop verifier + the post-apply check)
  shows it resolved; `--note` says what showed it.
- **Completion:** a blocker that is confirmed, deferred or revised keeps the task open
  until it is fixed, re-adjudicated, or the user explicitly accepts the risk. Diminishing
  returns ends the *re-running*, not the task — report the open blockers and ask.
- **Round integrity:** `critic-panel` returns `completion`, computed in code: the claim "no
  open blocker in: <focus>", its `verdict`, `missing`, and `notRechecked` (the prior records
  of every lens the round did not review: failed, out of scope, or opt-in and off). `reject`
  = a blocker is confirmed; `defer` = a lens failed, a finding went unassigned, a blocker is
  deferred or revised, or an open prior blocker (latest for its claim, not refuted, no CLEAR)
  sits in an unreviewed lens; otherwise `accept`. It sees only the priors passed in (`--brief`
  = the newest 40). A critic round is **clean only when `completion.verdict` is `accept`**. A
  round with `error` (every lens failed) or a failed in-scope lens is **incomplete**: it
  never satisfies a completion or Done gate, never counts as diminishing returns, and shows
  nothing fixed — never CLEAR, drop or resolve a record listed in `completion.notRechecked`.
  Re-run it; infra re-runs count toward the round cap, and at the cap report the failed
  lenses and ask. A `defer` caused only by open deferred or revised blockers follows the
  blocker rule under **Completion**. Every workflow fails the same way: when every agent of
  its first phase (reviewers, finders, category or evidence agents, implementers) failed, it
  returns `error` and writes no records; a partial failure, and any dead checker, stays per
  item (a named failed lens, category or dimension, or an `agent-failed` defer).

## The discipline — no durable state change without a record
| boundary | record writer | consumer action |
|---|---|---|
| loop-plan node → `done` / `deferred` / `escalated` | `loop-iteration` (+ Lead for post-apply checks) | CLEAR / HOLD |
| fact → memory wiki (`/dream ingest`) | `dream` (Lead) | COMMIT / COMMIT_QUALIFIED / QUARANTINE / REJECT |
| story status change (`/scan-project-docs`, `/sync-story-status`) | `scan-docs` (Lead for Browser verified/Done, citing the post-scan critic round) | COMMIT / COMMIT_QUALIFIED |
| critic finding acted on (`/multi-agent-dev`, `/qa-pass`, `/loop`) | `critic-panel` | CLEAR (fixed) / HOLD |
| prompt edit applied (`/improve-skills`) | `improve-skills` | CLEAR / REJECT |

Read-only rounds (`/critic-round`) still write their verdict records (memory, not code) —
that is what verdict reuse reads — and record their decision not to act (`HOLD`, note
"review-only round"). `e2e-design` and `gap-analysis` return advisory typed verdicts but
write no records: a separate checker types each proposal under the evidence gate
(`e2e-design`: one judge over every proposed case; `gap-analysis`: one skeptic per non-empty
dimension over its gaps), only `accept`/`qualify` proposals go on (cases returned for
implementation, gaps into the synthesized order), and no durable state changes on their output.

## Record guarantees ↔ how this repo enforces them
- **Immutability** — append-only store; ids are content hashes, so `pnpm trace lint` detects
  any line edited in place; corrections via `revises`. Writing the same draft twice is
  refused (content idempotency); duplicate consumer actions too.
- **No secrets, no bench answers** — the writer refuses drafts that look like they carry a
  key/token/private key, or a bench fixture id/defect text. If a secret ever lands anyway:
  rotate it — removing it means rewriting git history, a human decision.
- **Memory write boundary (policy v3)** — external content (a web page, a search result, a PR
  or issue comment, an outside MCP result, another agent's or a report's text) never licenses
  a wiki fact. For a `wiki:` claim the writer refuses an `accept` or `qualify` whose only
  evidence is `reading` (the evidence gate alone would let a causal or predictive claim
  qualify on it), a `file_line`, `command`, `browser`, `measurement` or `diff` item whose ref
  holds a URL that does not parse or whose host is not `localhost`, `127.0.0.1`, `[::1]`,
  `0.0.0.0` or `*.localhost`, and a `file_line` and a `diff` ref (each comma-separated part)
  that is not repo-relative (`pnpm trace reaudit` diffs repo paths only). `rule`, `human`,
  `record` and `reading` are exempt from the URL check: a WCAG URL stays citable as a rule,
  and external content is cited as `reading` (`external:<source>`) beside the local check
  that licenses the fact (`/dream` step 3b). Partial: a page saved into the repo and cited as
  `file_line` still passes, a `rule`, `human` or `record` item is trusted by its kind (a blog
  cited as a rule, a PR comment as a human decision, or any id cited as a record passes — a
  record ref is not checked to name an existing record), and only a `scheme://` URL is
  recognized (a scheme-less `example.com/x` or an `http:/…` form is not).
- **Wiki ↔ store agreement** — `pnpm trace wiki-check` (and a contracts test in `pnpm test`):
  each `<!-- rec:TR-… -->` comment in a topic page names the latest record for its claim, a
  licensing one, with a `COMMIT`/`COMMIT_QUALIFIED` whose `--ref` is that page, and a malformed
  one is an error, never a legacy bullet; each latest licensing `wiki:` record committed to a
  `topics/` page is still cited, since a fact leaves the wiki only through a revising record
  (`/dream` lint 1e), never a silent delete (a ref outside `topics/`, such as a bridged domain
  wiki, is not checked); `quarantine.md`'s rows are exactly the latest records whose last
  decision is `QUARANTINE` (`HOLD` and `REAUDIT` decide nothing); `index.md` stays within 150
  lines (a topic page over 200 lines, or this page over 400, is a warning; this page over 400
  also fails the contracts test). Partial: a legacy bullet without a rec comment is not
  checked, and whether a cited fact still holds is `pnpm trace reaudit`'s queue (a record
  whose commit the repository no longer has is listed apart, as `unreachable`).
- **Merges** — `.gitattributes` merges `records.jsonl` as a union (both branches' appends
  survive); `pnpm trace lint` (in `pnpm test`) is the post-merge check. Replay errors only
  on merge-invariant violations (schema, content-hash ids, unknown targets, verdict vs
  action); "this CLEAR was on a no-longer-newest record" depends on line order a union can
  interleave, so on replay it is a warning — the writer still refuses it at append time.
  Rotation runs only on the default branch (a union of two rotations would duplicate
  records).
- **Idempotent decisions, repeatable events** — re-recording an identical decision is a
  no-op (reported `noop`), never a batch failure; `REUSE` is an event and is stored each
  time it happens. A `REAUDIT` is a decision: its note names the changed evidence (or the
  unreachable commit and the paths to re-verify), so re-auditing an unchanged queue is a no-op
  rather than a line per stale record per pass. Action notes/refs are screened for secrets
  and bench ground truth exactly like records.
- **Version legibility** — `schema_version` const + `policy_version` stamp; a reader refuses
  records from a newer policy (`pnpm trace lint`).
- **Self-containment** — verdict, failed gates, missing, repair live in the record.
- **Provenance** — `writer_id` + `provenance.commit/workflow` (+ `provenance.tree`, the
  working-tree fingerprint); the writer fails closed without a commit.
- **Integrity gate in CI** — a vitest test replays the committed store (`pnpm test`).

## Debate-ness (D1–D4) of our critic panel, and the consensus rule
D1 role separation ✓ (own contexts) · D2 objective opposition ✓ (skeptic refutes) ·
D3 epistemic diversity ~ (Sonnet critics vs Opus verifier only) · D4 external adjudication
partial (verifier is an LLM; the deterministic bars — tests, axe, bundle budget, denylist —
are the real external judges). Because every critic is the same model, **agreement between
critics is weak evidence** (Prop. 4: n_eff = n/(1+(n−1)ρ̄) → 1 as ρ̄ → 1). `critic-panel`
therefore counts corroboration only when another critic brings *different* evidence, and
passes that evidence to the verifier; agreement alone never upgrades a finding.

**F1 response (fan-out shrunk where it was measured):** on code-only review the bench found
one all-lens reviewer as good as the critic panel at ~5x lower cost (record
TR-34201765532f — qualified: one run on the 19-fixture bench, 5 of the 10 critics, measured as diff-level block/no-block with the bench's own single-pass prompt — not this round's production prompt). So a code-only round (`uiInScope: false`) runs the Review
stage as ONE reviewer (`reviewMode: 'single-pass'`); rounds that drive the app keep one critic
per lens until the bench measures them. Both modes keep the skeptic per finding (D2), up to the
verifier cap; the rest are explicit defers (every blocker is verified; important findings past
`args.maxVerifiers`, default 30, are recorded as `defer` with `not-verified:verifier-cap`, never
dropped, and re-verified next round). In single-pass mode D1 (separate contexts) holds between
the reviewer and the skeptics only, so one reviewer's cross-lens duplicates never count as
independent corroboration.

## Stop conditions (paper §5.4) — used by `/loop` and `/multi-agent-dev`
Stop *re-running* when every claim is (1) a qualified proposal (accept/qualify, acted on),
(2) rejected, (3) deferred with named `missing`, or (4) **diminishing returns**: a re-run
left the set of open blockers (by `claim_id`) and their verdicts unchanged (compared only
between complete rounds) — report them and ask instead of spinning. Stopping is not
completing (see the consumer protocol).

## Verdict reuse (critic-panel)
A finding that re-raises a prior claim reuses the prior verdict without a new skeptic only
when **all** hold: it is deterministically the same claim (same lens, normalized title and
claim type — the critic's `revisits` link alone is never trusted), the prior verdict is
licensing (`accept`/`qualify` — defers and rejects are always re-adjudicated), and the
working tree is identical (`pnpm trace tree-id`: HEAD + uncommitted changes, excluding the
record store and loop/wiki bookkeeping files).

## Measurement & pre-registered falsification (TRACE-Bench-lite)
`/bench-checkers` runs `.claude/workflows/trace-bench.js` over seeded-defect fixtures
(`.claude/trace/bench/`); `pnpm trace bench-score` scores it; `pnpm trace metrics` scores
the live store. Pre-registered — results that count **against** our design:
- **F1** single-pass reviewer matches/beats the critic panel on recall and false-block
  rate → the fan-out is unjustified on this bench.
- **F2** the evidence gate never changes a verdict → it is decorative (informational).
- **F3** procedural invariance < 0.8 across identical re-runs → single-run verdicts are noise.
- **F4** the loop verifier licensed any bad fixture the denylist does not catch → the
  checker licenses bad diffs; keep loops at ≤ L2 and tighten it (emitted by `bench-score`).
- **F5** `consumerCoverage` < 0.5 over ≥ 10 current claims → records are an archive, not
  an instrument; cut fields (emitted by `pnpm trace metrics`; only decision actions count —
  REUSE/REAUDIT are bookkeeping).
- **F0** (validity precondition) ground truth reached a bench agent — a marker in what it
  *received* (prompt, tool results, injected context) — or an agent returned no verdict, or
  a run the workflow started never came back (`missingRuns`) → those runs are excluded, and
  the measurement record is `qualify`, not `accept`. F1 needs the `panel` arm; F3 needs
  `repeat ≥ 2`.

**Contamination rule (learned the hard way — the first bench run was contaminated):**
bench agents run inside this repo and grep it, so fixture ground truth must never be
plain text in the tree. Fixtures live gzip+base64-encoded in
`.claude/trace/bench/fixtures.bundle`; agents get opaque `fx-…` tokens, never real ids;
raw runs stay in the scratchpad (their verdict prose names the defects); bench records
carry counts only; a unit test scans the whole tree for leaked ids/defect text; and
`bench-score --transcripts` excludes any run whose agent received ground truth anyway.
Two precision rules, both from the held-out run (TR-039e311f20a2), where the instrument —
not the checker — caused the one excluded run and the one false hold: (1) the scan reads
only what the agent received (`receivedText`): its own messages and the echo of its
structured output are the measured output — a verifier that rewrites a defect description
from the diff alone found the defect, it was not told it (the bundle is gzip+base64, so
ground truth can only arrive as input; an unparsable line counts as received); (2) the
tree guard (`leakyFiles`) counts as "code" the tracked code files plus the untracked files a
fixture patch writes, so a fixture applied as a new file in a verifier's worktree does not
turn `pnpm test` red, while any other untracked file cannot whitelist its own tokens — ids
and defect text stay markers everywhere.

## Not adopted (deliberately)
The 8-stage reference writer and formulation gate (our inputs are diffs/flows, not
narrative text); the full 10-family taxonomy, ~60 Walton schemes and Dung semantics (5+1
claim types and 2–4 critical questions per critic lens suffice); Pearl do-calculus/bounds;
the `RecordUtility` scalar as a target (Goodhart — the paper says report-only); a separate
debate stage (critic panel + skeptic already is one).

## Gotchas
- Workflow scripts cannot `import`; shared deterministic blocks (`<trace-evidence-gate>`,
  `<loop-denylist>`, `<loop-verifier>`, `<critic-roster>`) are duplicated byte-for-byte
  and parity-tested — edit the canonical copy, paste into every marked block, run
  `pnpm test`. `scripts/trace/workflows.test.mjs` also runs the real workflow bodies with
  stub agents, so a deleted gate call or a broken reuse key fails a test.
- The store lives under `.claude/`, and the TRACE gate code under `scripts/trace/`; the
  `loop-iteration` denylist blocks both for implementer diffs — records are written only by
  checkers/the Lead via `pnpm trace`.
- `claim_id` must be stable across rounds for reuse/recurrence metrics to work; a reworded
  re-raise gets a new `claim_id` (fail-safe: it is re-verified, not reused).
- A Node script blocked in `spawnSync` cannot run `process.on('SIGINT'|'SIGTERM')` listeners
  until it yields to the event loop, and registering such a listener replaces the default
  exit-on-signal — a signal-safe long-running script must spawn asynchronously (that is why
  `bench-judge` uses async `spawn`). <!-- rec:TR-7bf1d1f3331a -->
- `JSON.parse` turns a `"__proto__"` key into an own property, and `Object.assign`/spread of
  that object rewrites the target's prototype — `pnpm trace write` refuses drafts with
  `__proto__`/`constructor`/`prototype` keys for this reason. <!-- rec:TR-f57f71d953ae -->
- Which paths a patch touches comes from git (`git diff --name-status -z -M -C`), not from
  parsing the patch text: a rename/copy-only patch has no `---`/`+++` lines, only
  `rename from`/`rename to` headers (`pnpm trace denylist-check` uses git's list).
  <!-- rec:TR-b2252b5e37e6 -->
- A content-addressed id must hash every field except the entry's OWN id — stripping a
  reference field (an action's `record_id`) made one action on two different records
  collide. <!-- rec:TR-b8824029fbed -->
- Test titles and assertion messages are printed to any agent that runs `pnpm test`, so
  tests over bench ground truth print only opaque tokens or counts.
  <!-- rec:TR-4483488be093 -->
- Node's spawn `timeout` option kills only the direct child. To kill a detached judge with
  its children, kill the process group with your own timer and do NOT forward `timeout`:
  Node refreshes loop time per `setTimeout`, so equal-delay timers can fire in different
  passes and the child's exit then cancels the group kill. <!-- rec:TR-b219013814f2 -->
- `git apply --numstat -z <patch>` names only the destination of a rename/copy; union it
  with `git apply --numstat -z -R <patch>` to see both sides (`pnpm trace denylist-check`
  does). <!-- rec:TR-269d82f78a84 -->
- `git apply` strips any one leading path component and accepts traditional `---`/`+++`
  sections (tab timestamps included) after a `diff --git` section, so an `a/`/`b/` regex
  misses files git will write — check the paths git reports before applying.
  <!-- rec:TR-00c2a9c72e0c -->
- "Does HEAD already contain this patch?" is a REVERSE check against HEAD in a throwaway
  index (`GIT_INDEX_FILE=<tmp> git read-tree HEAD`, then `git apply --cached -R --check`);
  a forward check is wrong — a pure-addition hunk applies again at an offset.
  <!-- rec:TR-4a5419c74c07 -->
- `git diff --src-prefix=a/ --dst-prefix=b/` emits `a/`/`b/` headers even under
  `diff.noprefix` or `diff.mnemonicPrefix`, so the loop implementer asks for them explicitly
  (the denylist parser accepts only `a/`/`b/`). <!-- rec:TR-40be9c919489 -->
- Measured (one run, 19-fixture bench, 5 of 10 critics, diff review only — no browser):
  a single-pass all-lens reviewer matched the critic panel (recall 1.00, false-block 0.14
  for both, panel = any critic blocks) at ~5x lower cost; the panel's majority vote lost
  recall (0.83) and its effective size was 1.89 of 5 (ρ̄ 0.41) — F1 fired.
  <!-- rec:TR-e1e16632e534 -->
- Measured (one fixture, one run): the loop verifier can license a diff because it "does
  exactly what the item asks" even when the item requests a change that contradicts a
  documented contract (code doc comment + an existing test's intent) — 1 of 2 repeats, so
  F4 fired and loops stay at ≤ L2 until the verifier is tightened. <!-- rec:TR-f1ebb8958183 -->
- Measured (in-sample — the rule was written after seeing the fixture that tripped F4; one
  run): with the documented-contract rule in the loop verifier, the 19-fixture bench at 3
  repeats gave WrongAcceptRate 0, FalseHoldRate 0, invariance 1.00; 4 of 12 bad fixtures are
  now held as `defer` for a human decision. <!-- rec:TR-5e53f695a9e6 -->
- Measured out of sample (one run; 6 bad + 4 good fixtures written by an independent agent
  blind to the contract rule, 3 repeats): the loop verifier licensed none of the 17 scored
  bad runs — 4 of the 6 held as `defer` for a human decision, 2 as `revise`, and 4 of the 6
  escape every deterministic check — and held 1 of 12 good runs, a hold caused by the bench's
  own leak-guard unit test going red on the patched tree, not by the diff. One bad run was
  excluded by F0, so the full-bench record is `qualify` and does not meet the L3 gate.
  <!-- rec:TR-00fe5f1e955b -->
- Measured (confirmatory run after both instrument fixes; 29 fixtures incl. the 10 held-out,
  3 repeats, nothing excluded): WrongAcceptRate 0, FalseHoldRate 0, invariance 1.00, only F2
  → the latest bench record is `accept` and the L3 measured-checker item is met. Qualified:
  two runs on the same fixtures; FalseHold 0 relies on the leak-guard fix made after the
  previous run (WrongAccept 0 does not); ~30% of verdicts are `defer`, so an L3 loop would
  still escalate often; it is one item of `loop-checklist.md`, not a license to run
  unattended. <!-- rec:TR-3ce4efb91999 -->

Related: [workflow](./workflow.md) · [quality-bar](./quality-bar.md) · [testing](./testing.md)
