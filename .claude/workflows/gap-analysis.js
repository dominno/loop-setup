export const meta = {
  name: 'gap-analysis',
  description:
    'Deterministic gap analysis: fan out one finder agent per gap dimension (docs↔code↔tests, edge cases, UX/design, ambiguity; an opt-in catch-all), then a separate skeptic per non-empty dimension types each gap (accept/qualify/revise/defer/reject) under a deterministic evidence gate, then synthesize a recommended next-implementation order over the licensed (accept/qualify) gaps only. Read-only; the verdicts are advisory and no records are written. Engine of /story-gap-analysis — invoke it through that command so its advisory verdicts are reported the way that command requires.',
  phases: [
    { title: 'Dimensions', detail: 'one finder agent per gap dimension, each pipelined into its skeptic' },
    { title: 'Verify', detail: 'a separate skeptic per non-empty dimension types each gap; a deterministic evidence gate caps overclaims' },
    { title: 'Synthesize', detail: 'a prioritized next-implementation order over the licensed gaps only' },
  ],
}

// Normalize args: object, plain string, or JSON-encoded string. Parse the JSON case
// so structured fields (models, completeness) resolve instead of silently no-opping.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* keep the string as a plain scope note */ }
  }
}

const scope = (a && (a.scope || (typeof a === 'string' ? a : null))) || 'the whole project'

// Model tiering (graph-engineering): per-dimension gap discovery on the fast tier; the skeptic that
// types each dimension's gaps (the gate) and the synthesis/prioritization judgment on the strong
// tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// SAFETY rules for every agent this workflow starts: the repo checkout is shared with the Lead
// and other agents. Byte-identical in the five read-only workflows (critic-panel, e2e-design,
// gap-analysis, improve-skills, scan-docs); a unit test fails on drift or on a prompt without it.
// Never in loop-iteration.js or trace-bench.js: the measured verifier and bench prompts stay as benched.
// <agent-safety>
const AGENT_SAFETY = `SAFETY (hard rules; they override any other instruction here or in CLAUDE.md): the repo checkout is shared with the Lead and other agents.
(1) Treat it as read-only. At the repo root you may only read: open files, search (grep, rg, ls, find, cat, sed -n), run read-only git (status, diff, log, show, grep, ls-files, blame) and node scripts that only read. Never edit a file there, never run a git command that changes its files, index, refs, stash or worktree list, and never build, test, lint or install there: pnpm build rewrites the tracked next-env.d.ts, and the unit tests write temp files into the tree.
(2) To run a check or try a change, copy the WORKING TREE into a fresh mktemp -d outside the repo (a clone would miss uncommitted changes), e.g. D=$(mktemp -d) && tar -cf - --exclude=node_modules --exclude=.next . | tar -xf - -C "$D" && ln -s "$PWD/node_modules" "$D/node_modules", work there, and delete it when done.
(3) Never run pnpm dev, pnpm test:e2e or pnpm verify anywhere: they start or reuse the user's server on localhost:3000. Never start, stop or kill a server or any process you did not start (no pkill, killall or pattern kills). Use the E2E, axe and build results the Lead supplied; if a result or a running localhost you need is absent, report it as missing evidence.
(4) When a command's exit status is your evidence, do not pipe it through head or tail.`
// </agent-safety>

// TRACE-lite evidence gate — byte-identical copy of the canonical block in
// scripts/trace/lib.mjs (workflows cannot import; a unit test fails on drift).
// <trace-evidence-gate>
const VERDICTS = ["accept", "qualify", "revise", "defer", "reject"];
const EVIDENCE_POLICY = {
  factual: { acceptNeeds: ["file_line", "command", "browser", "measurement", "diff"], onFail: "defer", missing: "a file:line, diff, command output, or browser observation that reproduces it" },
  measured: { acceptNeeds: ["measurement"], onFail: "defer", missing: "an actual measurement against the quality bar (axe run, pnpm check:bundle) — reading code is not a measurement" },
  causal: { acceptNeeds: ["command", "browser", "measurement"], onFail: "qualify", qualifier: "supported by code reading only — not demonstrated by an executed test, command, or browser repro" },
  predictive: { acceptNeeds: ["browser", "human"], onFail: "qualify", qualifier: "a prediction about users — not yet observed in the browser or by a human" },
  normative: { acceptNeeds: ["rule", "human"], onFail: "defer", missing: "the named rule or standard it violates (CLAUDE.md, quality-bar.md, WCAG, a project convention)" },
  practical: { acceptNeeds: ["diff"], onFail: "defer", missing: "the real diff of the change being licensed" },
};
function applyEvidenceGate(v) {
  const src = v || {};
  const out = {
    verdict: VERDICTS.includes(src.verdict) ? src.verdict : "defer",
    claimType: EVIDENCE_POLICY[src.claimType] ? src.claimType : "factual",
    evidenceChecked: Array.isArray(src.evidenceChecked) ? src.evidenceChecked.filter((e) => e && e.kind && e.ref) : [],
    failedGates: Array.isArray(src.failedGates) ? src.failedGates.filter(Boolean) : [],
    missing: Array.isArray(src.missing) ? src.missing.filter(Boolean) : [],
    repair: typeof src.repair === "string" ? src.repair : "",
    qualifier: typeof src.qualifier === "string" ? src.qualifier : "",
  };
  if (!VERDICTS.includes(src.verdict)) {
    out.failedGates.push("verdict-missing");
    out.missing.push("a verdict from the checker (none, or an unknown value, was returned)");
  }
  if (!EVIDENCE_POLICY[src.claimType]) out.failedGates.push(`claim-type-unknown:${src.claimType}`);
  const kinds = new Set(out.evidenceChecked.map((e) => e.kind));
  const rule = EVIDENCE_POLICY[out.claimType];
  // Both licensing verdicts face the floor: a checker cannot dodge it by self-demoting
  // to qualify. Only types whose fallback IS qualify (causal, predictive) may qualify on
  // weaker evidence; for the rest a qualify without the needed kind becomes defer.
  const licensing = out.verdict === "accept" || out.verdict === "qualify";
  if (licensing && !rule.acceptNeeds.some((k) => kinds.has(k)) && (out.verdict === "accept" || rule.onFail !== "qualify")) {
    out.failedGates.push(`evidence-gate:${out.claimType}:${out.verdict}-needs-${rule.acceptNeeds.join("|")}`);
    out.verdict = rule.onFail;
    if (rule.onFail === "qualify") out.qualifier = out.qualifier || rule.qualifier;
    else out.missing.push(rule.missing);
  }
  if (out.verdict === "qualify" && kinds.size === 0) {
    out.failedGates.push("evidence-gate:qualify-needs-evidence");
    out.verdict = "defer";
    out.missing.push("any concrete evidence (the checker cited none)");
  }
  if (out.verdict === "qualify" && !out.qualifier) out.qualifier = "qualified by the checker (no qualifier text given)";
  if (out.verdict === "defer" && out.missing.length === 0) {
    out.failedGates.push("defer-without-missing");
    out.missing.push("unspecified — the checker deferred without naming the missing evidence");
  }
  if (out.verdict === "revise" && !out.repair) {
    out.failedGates.push("revise-without-repair");
    out.repair = "unspecified — the checker asked for a revision without stating it";
  }
  return out;
}
// Re-typing must never lower the bar: gate the verdict under every candidate type (the
// maker's and the checker's) and keep the most conservative outcome.
function applyEvidenceGateStrict(v, claimTypes) {
  const types = (claimTypes || []).filter((t, i, all) => EVIDENCE_POLICY[t] && all.indexOf(t) === i);
  if (types.length < 2) return applyEvidenceGate(types.length ? { ...(v || {}), claimType: types[0] } : v);
  const rank = (r) => (r.verdict === "accept" ? 2 : r.verdict === "qualify" ? 1 : 0);
  return types.map((t) => applyEvidenceGate({ ...(v || {}), claimType: t })).reduce((a, b) => (rank(b) < rank(a) ? b : a));
}
// </trace-evidence-gate>
const EVIDENCE_KINDS = ['file_line', 'command', 'browser', 'measurement', 'rule', 'diff', 'reading', 'record', 'human']
const LICENSING = ['accept', 'qualify']
// The claim types a skeptic may re-type a gap to (`practical` is for apply-this-change claims).
// Each type's evidence floor comes from EVIDENCE_POLICY above.
const GAP_CLAIM_TYPES = ['factual', 'measured', 'causal', 'predictive', 'normative']

// Each finder claims that every gap it returns is real, typed `claimType`: 'predictive' for
// ux-design (how users would react), 'factual' for the rest. `cq` = the critical questions the
// dimension's skeptic puts to each gap, so refutation is a checklist, not improvisation.
const DIMENSIONS = [
  { key: 'docs-not-impl', claimType: 'factual', prompt: 'Requirements in docs (docs/prd.md, docs/stories/*, README) with NO implementation evidence in the codebase.',
    cq: ['Which doc line states the requirement (file:line)?', 'Which search for an implementation did you run, and what did it return?', 'Is it implemented under another name, route or component?'] },
  { key: 'impl-not-docs', claimType: 'factual', prompt: 'Implemented features/behaviors NOT described in any product doc.',
    cq: ['Which file:line implements the behavior?', 'Which search of the product docs (docs/prd.md, docs/stories/, README) did you run for it, and what did it return?', 'Is it a product behavior, or scaffolding, tooling or test-only code?'] },
  { key: 'impl-not-unit', claimType: 'factual', prompt: 'Stories/behaviors implemented but lacking meaningful unit tests.',
    cq: ['Which file:line implements the behavior?', 'Which search of the unit tests did you run for it, and what did it return?', 'Does an existing unit test already assert it under another name (quote it)?'] },
  { key: 'impl-not-e2e', claimType: 'factual', prompt: 'Stories/flows implemented but lacking Playwright E2E coverage.',
    cq: ['Which route or component implements the flow (file:line)?', 'Which e2e spec already asserts it? Name the search of e2e/ you ran and what it returned.', 'Does the flow have a user-visible outcome an E2E test could assert?'] },
  { key: 'e2e-missing-edges', claimType: 'factual', prompt: 'Flows with E2E coverage that miss important failure/edge cases.',
    cq: ['Which e2e spec covers the flow (file:line), and which failure or edge case does it leave unasserted?', 'Is that case reachable in the real app (the file:line that handles it)?', 'Does another spec or a unit test already assert it?'] },
  { key: 'ux-design', claimType: 'predictive', prompt: 'Flows that work functionally but would fail a UX / Designer / Artistic Direction review.',
    cq: ['Is the problem observable on the rendered page, or only inferred from code?', 'Which element or copy causes it (file:line), and which stated rule or design intent does it miss?', 'Does an existing visible cue already resolve it?'] },
  { key: 'ambiguous', claimType: 'factual', prompt: 'Ambiguous or contradictory requirements across the docs.',
    cq: ['Which doc lines conflict, or which line admits two readings (file:line each)?', 'Does a later doc, story or acceptance criterion already resolve it?'] },
]

// Opt-in catch-all (args.completeness === true; off by default): one more finder for the gaps that
// NONE of the dimensions above covers (its anti-scope). Its gaps face the same skeptic and gate.
const completeness = !!a && a.completeness === true
if (a && typeof a === 'object' && a.completeness !== undefined && typeof a.completeness !== 'boolean') log(`ignored args.completeness=${JSON.stringify(a.completeness)} (expected true or false) — the catch-all dimension stays off`)
const OTHER = {
  key: 'other', claimType: 'factual',
  prompt: `Any other gap between the docs, the code and the tests that NONE of these dimensions covers (each has its own agent; do not repeat their gaps):\n${DIMENSIONS.map((d) => `- ${d.key}: ${d.prompt}`).join('\n')}`,
  cq: ['Which dimension above already covers it? If one does, it is out of scope here: reject it.', 'Which file:line or command output shows the gap?'],
}
const DIMS = completeness ? [...DIMENSIONS, OTHER] : DIMENSIONS

const GAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['item', 'detail', 'priority'],
        properties: {
          item: { type: 'string' },
          detail: { type: 'string', description: 'concrete evidence: file/story/test reference' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

// The skeptic's verdict on each numbered gap of its dimension.
const SKEPTIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'exactly one verdict per numbered gap',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'verdict', 'claimType', 'evidenceChecked', 'counterReasons', 'missing', 'repair', 'qualifier', 'reason'],
        properties: {
          index: { type: 'integer', description: 'the index of the gap this verdict is for' },
          verdict: { type: 'string', enum: VERDICTS, description: 'accept = the gap holds as stated; qualify = it holds only in a narrower form (say which in qualifier); revise = it does not hold as stated, but a restated gap does (give it in repair); defer = it cannot be settled with the evidence available (name missing); reject = refuted' },
          claimType: { type: 'string', enum: GAP_CLAIM_TYPES, description: 'the claim type after your review (re-type it if the finder mistyped it)' },
          evidenceChecked: {
            type: 'array',
            description: 'the evidence YOU actually checked — kind + ref (+ result). Only cite what you verified.',
            items: {
              type: 'object', additionalProperties: false, required: ['kind', 'ref'],
              properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
            },
          },
          counterReasons: { type: 'array', items: { type: 'string' }, description: 'the critical questions you put to the gap and how each came out' },
          failedGates: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' }, description: 'for defer: the evidence that would settle it' },
          repair: { type: 'string', description: 'for revise: the gap restated so that it holds; else empty' },
          qualifier: { type: 'string', description: 'for qualify: the narrower form the gap holds in; else empty' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const ORDER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['order'],
  properties: {
    order: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['next', 'why'],
        properties: { next: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
}

// An agent() that throws (token budget spent, harness error) is a FAILED agent, not a crashed
// run: log it and return the same null a dead agent returns, so the failure is reported. Every
// agent() starts inside a then(), so one that throws before it returns a promise takes this
// .catch too, the synthesizer's top-level await included.
const agentFailed = (label) => (e) => {
  log(`agent failed: ${label}: ${String((e && e.message) || e).slice(0, 200)}`)
  return null
}
const tally = (list) => Object.fromEntries(VERDICTS.map((v) => [v, list.filter((g) => g.verdict === v).length]))

// Budget floors fire only when the turn has a '+Nk' token target (budget.total), against the
// output tokens left in the shared pool. Under START_FLOOR no finder starts (an error: nothing was
// analysed). SYNTH_FLOOR guards every later agent: under it a dimension's skeptic does not start (its
// gaps defer, unverified), and after the skeptics no synthesizer starts (the licensed gaps stand unordered).
const START_FLOOR = 40_000
const SYNTH_FLOOR = 20_000
const floorNote = (floor) => `token budget floor reached (${Math.round(budget.remaining() / 1000)}k left < ${floor / 1000}k)`
if (budget.total && budget.remaining() < START_FLOOR) {
  const error = `${floorNote(START_FLOOR)} — no dimension was analysed; re-run with a larger budget`
  log(`ERROR: ${error}`)
  return {
    scope, error, budgetStopped: true, totalGaps: 0, licensedGaps: 0, byDimension: {}, deferred: [], rejected: [],
    failedDimensions: DIMS.map((d) => d.key), // none was analysed: never read as "no gaps"
    recommendedOrder: null, missing: ['a synthesized order — skipped: no dimension was analysed (token budget floor)'], verdictCounts: tally([]),
  }
}

// The skeptic of one dimension gets its numbered gaps, the evidence floor of its claim type and its
// critical questions. It is asked to refute; an absence counts as evidence only through a search.
const skepticPrompt = (d, numbered) => {
  const rule = EVIDENCE_POLICY[d.claimType]
  return `You are the SKEPTIC for one dimension of a gap analysis of "${scope}". A separate finder agent was asked for:\n${d.prompt}\nIt returned the numbered gaps below, each a ${d.claimType} claim that the gap is real. Try to REFUTE each one: open the files it cites and run your own searches over docs/, src/ and e2e/. Then return exactly one typed verdict per gap, by its index:\n- accept: the gap holds as stated, on evidence YOU checked;\n- qualify: it holds only in a narrower form (say which in qualifier);\n- revise: it does not hold as stated, but a restated gap does (put that gap in repair);\n- defer: you cannot settle it with the evidence available (name exactly what is missing);\n- reject: refuted (say in reason what you found, e.g. the implementation, doc or test it calls absent).\nAn absence ("no implementation", "no test", "not documented") is shown only by a search: cite the search command you ran and its empty result as command evidence. Default to defer when you cannot check the evidence, and never accept on the finder's word: cite in evidenceChecked only what YOU opened or ran. An accept needs evidence of kind ${rule.acceptNeeds.join('/')} that YOU checked ("reading" alone never satisfies it); otherwise it is capped at ${rule.onFail}. Re-type a gap's claimType if the finder mistyped it; the gate then holds it to the stricter of the two types.\n\nCritical questions for this dimension (put each to every gap and answer them in counterReasons):\n${d.cq.map((q) => `- ${q}`).join('\n')}\n\n${AGENT_SAFETY}\n\nGaps (one JSON object per line):\n${numbered.join('\n')}`
}

// A gap no single verdict settles: deferred, never licensed or rejected.
const unsettled = (g, gate, missing, reason) => ({
  ...g, verdict: 'defer', preGateVerdict: null, qualifier: '', repair: '', evidenceChecked: [], counterReasons: [],
  failedGates: [gate], missing: [missing], reason,
})

// Settle every gap of one dimension from its skeptic's reply `v` (null: it threw or returned nothing).
const settle = (gaps, v, d) => {
  // The live skeptic's verdicts, grouped by gap index. A verdict for no listed gap is ignored.
  const byIndex = new Map()
  let unmatched = 0
  for (const x of v && Array.isArray(v.verdicts) ? v.verdicts : []) {
    if (!x || !Number.isInteger(x.index) || x.index < 1 || x.index > gaps.length) {
      unmatched += 1
      continue
    }
    byIndex.set(x.index, [...(byIndex.get(x.index) || []), x])
  }
  if (unmatched) log(`ignored ${unmatched} ${d.key} skeptic verdict(s) for no listed gap`)
  return gaps.map((g) => {
    const entries = byIndex.get(g.index) || []
    // Repeated verdicts that disagree settle nothing: neither the first nor the last may win.
    if (entries.some((e) => e.verdict !== entries[0].verdict)) {
      const said = entries.map((e) => e.verdict).join(', ')
      return unsettled(g, 'verdict-conflict', `one verdict for gap ${g.id} (the skeptic returned ${said})`, `the skeptic returned disagreeing verdicts for this gap: ${said}`)
    }
    const x = entries[0]
    // Fail safe: a dead skeptic, or an index it skipped, is defer ('verdict-missing'; never licensed,
    // never rejected). A dead skeptic is also 'agent-failed': an infra failure to re-run. Only this
    // code sets that gate, so a live skeptic's own 'agent-failed' is dropped. Re-typing never lowers
    // the bar: the gate runs under the skeptic's claim type and the dimension's, keeping the stricter.
    const r = applyEvidenceGateStrict(x || {}, [x && x.claimType, d.claimType])
    return {
      ...g,
      verdict: r.verdict,
      preGateVerdict: (x && x.verdict) || null,
      claimType: r.claimType,
      ...(x && EVIDENCE_POLICY[x.claimType] && x.claimType !== d.claimType ? { retypedFrom: d.claimType } : {}),
      qualifier: r.qualifier,
      missing: r.missing,
      repair: r.repair,
      failedGates: v ? r.failedGates.filter((f) => f !== 'agent-failed') : [...r.failedGates, 'agent-failed'],
      evidenceChecked: r.evidenceChecked,
      counterReasons: (x && Array.isArray(x.counterReasons) && x.counterReasons) || [],
      reason: (x && x.reason) || (v ? 'the skeptic gave no verdict for this gap' : 'the skeptic returned nothing — deferred, not verified'),
    }
  })
}

// Stage 2: the dimension's skeptic. A dead finder analysed nothing (a failed dimension, never "no
// gaps"); an empty dimension needs no skeptic; under the floor its gaps defer, unverified.
const verifyDimension = async (found, d, i) => {
  if (!found) return { dimension: d.key, failed: true, gaps: [] }
  const gaps = (Array.isArray(found.gaps) ? found.gaps : []).map((g, k) => ({ ...g, dimension: d.key, index: k + 1, id: `${d.key}#${k + 1}`, claimType: d.claimType }))
  if (!gaps.length) return { dimension: d.key, failed: false, gaps }
  const label = `gap-verify:${d.key}-${i}`
  const stop = budget.total && budget.remaining() < SYNTH_FLOOR ? floorNote(SYNTH_FLOOR) : ''
  if (stop) {
    log(`${stop} — no skeptic started for ${d.key}; its ${gaps.length} gap(s) are deferred (not-verified:budget)`)
    return {
      dimension: d.key, failed: false,
      gaps: gaps.map((g) => unsettled(g, 'not-verified:budget', `a skeptic verdict — skipped: ${stop}; re-run with a larger budget`, 'not verified: no skeptic started below the budget floor')),
    }
  }
  const numbered = gaps.map((g) => JSON.stringify({ index: g.index, item: g.item, detail: g.detail, priority: g.priority }))
  // agent() may also throw before it returns a promise: started inside then(), that throw reaches
  // agentFailed too, so the dimension's gaps are deferred instead of dropped with the stage.
  const v = await Promise.resolve()
    .then(() => agent(skepticPrompt(d, numbered), { label, phase: 'Verify', schema: SKEPTIC_SCHEMA, model: JUDGE_MODEL }))
    .catch(agentFailed(label))
  if (!v) log(`WARNING: the ${d.key} skeptic returned no result — its ${gaps.length} gap(s) are deferred (agent-failed: re-run)`)
  return { dimension: d.key, failed: false, gaps: settle(gaps, v, d) }
}

// Pipeline: each dimension flows through finder → skeptic independently (no barrier). Every stage
// gets (prevResult, dimension, index), the first included, so the labels carry the map index.
phase('Dimensions')
const results = await pipeline(
  DIMS,
  (d, _d, i) =>
    Promise.resolve()
      .then(() =>
        agent(
          `Analyze the gap for "${scope}" along this dimension by reading docs/, src/, e2e/, and the story map:\n${d.prompt}\nReturn only gaps backed by concrete references; an empty list is a valid, honest answer.\n\n${AGENT_SAFETY}`,
          { label: `gap:${d.key}-${i}`, phase: 'Dimensions', schema: GAP_SCHEMA, model: FANOUT_MODEL },
        ),
      )
      .catch(agentFailed(`gap:${d.key}-${i}`)),
  verifyDimension,
)
// A dimension whose finder died analysed nothing — that is NOT "no gaps": it is named in
// failedDimensions and left out of byDimension. `results` is index-aligned with DIMS.
const failedDimensions = results.map((r, i) => (!r || r.failed ? DIMS[i].key : null)).filter(Boolean)
if (failedDimensions.length) log(`WARNING: ${failedDimensions.length} dimension(s) returned no result: ${failedDimensions.join(', ')} — not analysed`)
// Every finder failed: nothing was analysed, so the run is an error and nothing is verified or
// synthesized. Every key of an analysed run is still present (empty), so no reader mistakes it.
if (failedDimensions.length === DIMS.length) {
  const error = `all ${DIMS.length} dimensions failed (infra) — no gaps were analysed; re-run`
  log(`ERROR: ${error}`)
  return {
    scope, error, totalGaps: 0, licensedGaps: 0, byDimension: {}, deferred: [], rejected: [], failedDimensions,
    recommendedOrder: null, missing: ['a synthesized order — skipped: no dimension was analysed'], verdictCounts: tally([]),
  }
}

// byDimension keeps every analysed gap with its verdict; deferred and rejected list those gaps across
// dimensions (each names its dimension and id). Only accept/qualify gaps are licensed.
const byDimension = {}
for (const r of results.filter((x) => x && !x.failed)) byDimension[r.dimension] = r.gaps
const all = Object.values(byDimension).flat()
const licensed = all.filter((g) => LICENSING.includes(g.verdict))
const deferred = all.filter((g) => g.verdict === 'defer')
const rejected = all.filter((g) => g.verdict === 'reject')
// A skeptic that never changes anything (everything accepted) shows up here.
const verdictCounts = tally(all)
log(`${all.length} gaps across ${DIMS.length - failedDimensions.length} of ${DIMS.length} dimensions; ${licensed.length} licensed — ${VERDICTS.map((v) => `${v} ${verdictCounts[v]}`).join(', ')}`)

// Synthesize over the LICENSED gaps only (each with its qualifier), and only when there is one: a
// gap no skeptic licensed never shapes the order.
phase('Synthesize')
const synthStop = licensed.length && budget.total && budget.remaining() < SYNTH_FLOOR ? floorNote(SYNTH_FLOOR) : ''
if (synthStop) log(`${synthStop} — no synthesizer started; the licensed gaps stand unordered`)
const licensedByDimension = {}
for (const g of licensed) {
  const entry = { id: g.id, item: g.item, detail: g.detail, priority: g.priority, verdict: g.verdict, ...(g.qualifier ? { qualifier: g.qualifier } : {}) }
  licensedByDimension[g.dimension] = [...(licensedByDimension[g.dimension] || []), entry]
}
// Started inside then(), so an agent() that throws synchronously takes the same .catch as one that
// rejects, instead of crashing the run at this top-level await.
const synth = !licensed.length || synthStop ? null : await Promise.resolve()
  .then(() =>
    agent(
      `Given these gaps grouped by dimension, propose the recommended NEXT-implementation order (highest-leverage first), each with a one-line "why". Be concrete. A separate skeptic licensed every gap here: an "accept" holds as stated, a "qualify" only in the narrower form its qualifier states, so keep such a gap within it. Order only these gaps, and cite in each "why" the id of every gap the item addresses.\n\n${JSON.stringify(licensedByDimension)}\n\n${AGENT_SAFETY}`,
      { label: 'synthesize', phase: 'Synthesize', schema: ORDER_SCHEMA, model: JUDGE_MODEL },
    ),
  )
  .catch(agentFailed('synthesize'))
// The order is null with its missing named when a dead synthesizer or the pre-synth floor left the
// licensed gaps unordered, or when no gap is licensed while deferred or revised gaps remain: never an
// empty "nothing to do". It is empty only when no gap is open (none found, or every one refuted).
const open = licensed.length + verdictCounts.defer + verdictCounts.revise
const recommendedOrder = synth ? synth.order || [] : open ? null : []
const missing = recommendedOrder ? [] : [
  !licensed.length
    ? `a synthesized order — none was synthesized: no gap is licensed (accept/qualify); settle the ${verdictCounts.defer} deferred gap(s) (an agent-failed one needs a re-run, the rest their missing evidence) and the ${verdictCounts.revise} revised gap(s) (adjudicate each repair), then re-run`
    : synthStop
      ? `a synthesized order — synthesis skipped: ${synthStop}; the licensed gaps are listed unordered in byDimension`
      : 'a synthesized order — the synthesizer failed (infra); the licensed gaps are listed unordered in byDimension',
]

return { scope, totalGaps: all.length, licensedGaps: licensed.length, byDimension, deferred, rejected, failedDimensions, recommendedOrder, missing, verdictCounts }
