export const meta = {
  name: 'e2e-design',
  description:
    'Deterministic E2E test design: fan out one agent per path category (happy, failure, edge, accessibility, regression) to enumerate concrete Playwright test cases for a flow, dedup them, then a separate judge types each case (accept/qualify/revise/defer/reject) under the visible-outcome rule and a deterministic evidence gate. Only licensed (accept/qualify) cases are returned for the caller to implement; the verdicts are advisory and no records are written.',
  phases: [
    { title: 'Design', detail: 'one agent per path category enumerates test cases in parallel' },
    { title: 'Judge', detail: 'a separate judge types each deduped case; a deterministic evidence gate caps overclaims' },
  ],
}

// Normalize args: object, plain string, or JSON-encoded string. Parse the JSON case
// so structured fields (models) resolve instead of silently no-opping.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* keep the string as a plain flow note */ }
  }
}

const flow = (a && (a.flow || (typeof a === 'string' ? a : null))) || 'the target flow'

// Model tiering (graph-engineering): the per-category enumeration is fan-out on the fast tier
// (the dedup is plain code, not an agent); the judge that types each case is the gate, on the
// strong tier. Override via args.models.
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

const CATEGORIES = [
  { key: 'happy', prompt: 'the happy path(s) a user follows when everything works' },
  { key: 'failure', prompt: 'validation/failure paths and error states' },
  { key: 'edge', prompt: 'boundary/edge cases (limits, empty input, special characters, reload/persistence)' },
  { key: 'accessibility', prompt: 'keyboard navigation and accessible-name/role assertions' },
  { key: 'regression', prompt: 'existing flows this change could break' },
]

const CASES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cases'],
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'steps', 'expected'],
        properties: {
          title: { type: 'string' },
          steps: { type: 'string' },
          expected: { type: 'string', description: 'visible outcome to assert — not just page load' },
        },
      },
    },
  },
}

// The judge's verdict on each numbered case. Each case is the category agent's factual claim:
// "a distinct case whose expected outcome is user-visible, and that no existing spec asserts".
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'exactly one verdict per numbered case',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'verdict', 'evidenceChecked', 'missing', 'repair', 'qualifier', 'reason'],
        properties: {
          index: { type: 'integer', description: 'the index of the case this verdict is for' },
          verdict: { type: 'string', enum: VERDICTS, description: 'accept = distinct, user-visible, not yet covered; qualify = holds only in a narrower form (say which in qualifier); revise = the outcome is not user-visible (give a visible restatement in repair); reject = a duplicate (duplicateOf), already covered (coveredBy) or unobservable; defer = cannot tell (name missing)' },
          duplicateOf: { type: 'integer', description: 'reject as a duplicate: the index of the case in this list it duplicates' },
          coveredBy: { type: 'string', description: 'reject as already covered: the e2e/*.spec.ts file:line that already asserts it' },
          evidenceChecked: {
            type: 'array',
            description: 'the evidence YOU actually checked — kind + ref (+ result). Only cite what you verified.',
            items: {
              type: 'object', additionalProperties: false, required: ['kind', 'ref'],
              properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
            },
          },
          failedGates: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' }, description: 'for defer: the evidence that would settle it' },
          repair: { type: 'string', description: 'for revise: the case restated with a user-visible expected outcome; else empty' },
          qualifier: { type: 'string', description: 'for qualify: the narrower form the case holds in; else empty' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

// An agent() that throws (token budget spent, harness error) is a FAILED agent, not a crashed
// run: log it and return the same null a dead agent returns, so the category is reported.
const agentFailed = (label) => (e) => {
  log(`agent failed: ${label}: ${String((e && e.message) || e).slice(0, 200)}`)
  return null
}
const tally = (list) => Object.fromEntries(VERDICTS.map((v) => [v, list.filter((c) => c.verdict === v).length]))

phase('Design')
const results = await parallel(
  CATEGORIES.map((c, i) => () =>
    agent(
      `Enumerate concrete Playwright E2E test cases for "${flow}" covering ${c.prompt}. Inspect the routes/components and existing specs first. Each case needs: title, steps, and the visible expected outcome to assert.\n\n${AGENT_SAFETY}`,
      { label: `e2e:${c.key}-${i}`, phase: 'Design', schema: CASES_SCHEMA, model: FANOUT_MODEL },
    )
      .catch(agentFailed(`e2e:${c.key}-${i}`))
      .then((r) => ({ cases: ((r && r.cases) || []).map((x) => ({ ...x, category: c.key })), failed: !r })),
  ),
)
// A category whose agent died enumerated nothing — that is NOT "no cases". `results` is
// index-aligned with CATEGORIES (a dead parallel() thunk is a null slot), so each is named.
const failedCategories = results.map((r, i) => (!r || r.failed ? CATEGORIES[i].key : null)).filter(Boolean)
if (failedCategories.length) log(`WARNING: ${failedCategories.length} categor(y/ies) returned no result: ${failedCategories.join(', ')} — not enumerated`)
// Every category failed: nothing was designed, so the run is an error, not an empty case list.
// Nothing is judged; every key of a judged run is still present (empty), so no reader mistakes it.
if (failedCategories.length === CATEGORIES.length) {
  const error = `all ${CATEGORIES.length} path categories failed (infra) — no cases were designed; re-run`
  log(`ERROR: ${error}`)
  return { flow, error, judged: false, failedCategories, count: 0, cases: [], covered: [], revised: [], deferred: [], rejected: [], verdictCounts: tally([]) }
}

const all = results.filter(Boolean).flatMap((r) => r.cases)
const seen = new Set()
const designed = all.filter((c) => {
  // Key on category + title so a failure-path case isn't dropped for sharing a
  // title with a happy-path case.
  const k = `${c.category}::${String(c.title || '').trim().toLowerCase()}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
log(`${designed.length} test cases (${all.length} before dedup) for "${flow}"`)

// Judge — ONE separate agent (the enumerating agents never judge their own cases) types every
// deduped case, numbered from 1, under the visible-outcome rule of docs/e2e-coverage-map.md. Each
// verdict is settled as a factual claim by the evidence gate. The verdicts are advisory: no
// records are written and no durable state changes on them. With a '+Nk' token target, under
// JUDGE_FLOOR no judge starts and every case is deferred, unjudged; no case means no judge.
phase('Judge')
const JUDGE_FLOOR = 20_000
const judgeStop = designed.length && budget.total && budget.remaining() < JUDGE_FLOOR
  ? `token budget floor reached before Judge (${Math.round(budget.remaining() / 1000)}k left < ${JUDGE_FLOOR / 1000}k)`
  : ''
if (judgeStop) log(`${judgeStop} — no judge started; ${designed.length} case(s) deferred (not-verified:budget)`)
const numbered = designed.map((c, i) => JSON.stringify({ index: i + 1, category: c.category, title: c.title, steps: c.steps, expected: c.expected }))
const judge = !designed.length || judgeStop ? null : await agent(
  `You are the JUDGE of proposed Playwright E2E test cases for "${flow}". Other agents enumerated the numbered cases below; each claims to be a distinct case worth implementing, whose expected outcome is user-visible and that no existing spec already asserts. Try to REFUTE each one: read the routes and components that render the flow, its acceptance criteria (docs/stories/, docs/prd.md) and the existing specs (e2e/*.spec.ts). Then return exactly one typed verdict per case, by its index:\n- accept: a distinct case whose expected outcome is user-visible. The visible-outcome rule (docs/e2e-coverage-map.md): a test counts only when it asserts a visible outcome, not just page load. Cite the file:line that renders the outcome, or the acceptance criterion that specifies it, as file_line evidence.\n- qualify: it holds only in a narrower form; say which in qualifier, with the same evidence.\n- revise: the expected outcome is not user-visible as stated; put the case restated with a visible outcome in repair.\n- reject: a duplicate of another case in this list (set duplicateOf to that case's index), already asserted by an existing e2e/*.spec.ts (set coveredBy to that spec's file:line and cite it as file_line evidence), or unobservable in the browser (say why in reason).\n- defer: you cannot tell from the evidence available (name exactly what is missing).\nDefault to defer when you cannot check the evidence, and never accept on the enumerating agent's word: cite in evidenceChecked only what YOU opened or ran. An accept or qualify needs evidence of kind ${EVIDENCE_POLICY.factual.acceptNeeds.join('/')} that YOU checked ("reading" alone never licenses a case); otherwise it is capped at ${EVIDENCE_POLICY.factual.onFail}.\n\n${AGENT_SAFETY}\n\nCases (one JSON object per line):\n${numbered.join('\n')}`,
  { label: 'e2e:judge-0', phase: 'Judge', schema: JUDGE_SCHEMA, model: JUDGE_MODEL },
).catch(agentFailed('e2e:judge-0'))
if (designed.length && !judgeStop && !judge) log(`WARNING: the judge returned no result — every case is deferred (agent-failed: re-run)`)

// The live judge's verdicts, grouped by case index. A verdict for no listed case is ignored.
const byIndex = new Map()
let unmatched = 0
for (const v of judge && Array.isArray(judge.verdicts) ? judge.verdicts : []) {
  if (!v || !Number.isInteger(v.index) || v.index < 1 || v.index > designed.length) {
    unmatched += 1
    continue
  }
  byIndex.set(v.index, [...(byIndex.get(v.index) || []), v])
}
if (unmatched) log(`ignored ${unmatched} judge verdict(s) for no listed case`)

// A case no single verdict settles: deferred, never accepted or rejected.
const unsettled = (c, index, gate, missing, reason) => ({
  ...c, index, verdict: 'defer', preGateVerdict: null, qualifier: '', repair: '', evidenceChecked: [],
  failedGates: [gate], missing: [missing], reason,
})
// The covering spec and the twin a verdict names ('' / null when it names none): the grounds of a reject.
const coveredByOf = (v) => (v && typeof v.coveredBy === 'string' && v.coveredBy.trim()) || ''
const twinOf = (v) => (v && Number.isInteger(v.duplicateOf) ? v.duplicateOf : null)
const gated = designed.map((c, i) => {
  const index = i + 1
  if (judgeStop) return unsettled(c, index, 'not-verified:budget', `a judge verdict — skipped: ${judgeStop}; re-run with a larger budget`, 'not judged: no judge started below the budget floor')
  const entries = byIndex.get(index) || []
  // Repeated verdicts that disagree settle nothing: neither the first nor the last may win.
  if (entries.some((e) => e.verdict !== entries[0].verdict)) {
    const said = entries.map((e) => e.verdict).join(', ')
    return unsettled(c, index, 'verdict-conflict', `one verdict for case #${index} (the judge returned ${said})`, `the judge returned disagreeing verdicts for this case: ${said}`)
  }
  const v = entries[0]
  // A licensing verdict that also names a covering spec or a twin contradicts itself: it would return a
  // case for implementation that it also calls covered or a duplicate. It settles nothing either.
  const named = v && LICENSING.includes(v.verdict) ? [coveredByOf(v) && `coveredBy ${coveredByOf(v)}`, twinOf(v) !== null && `duplicateOf #${twinOf(v)}`].filter(Boolean) : []
  if (named.length) {
    const said = `${v.verdict} with ${named.join(' and ')}`
    return unsettled(c, index, 'verdict-conflict', `one consistent verdict for case #${index} (the judge returned ${said}; only a reject names a covering spec or a twin)`, `the judge's verdict contradicts itself: ${said}`)
  }
  // Fail safe: a dead judge (threw, or returned nothing) or an index it skipped is defer
  // ('verdict-missing'; never confirmed, never rejected). A dead judge is also 'agent-failed':
  // an infra failure to re-run. Only this code sets that gate, so a live judge's own
  // 'agent-failed' is dropped (a live checker cannot forge the infra signal).
  const g = applyEvidenceGate({ ...(v || {}), claimType: 'factual' })
  const out = {
    ...c,
    index,
    verdict: g.verdict,
    preGateVerdict: (v && v.verdict) || null,
    qualifier: g.qualifier,
    missing: g.missing,
    repair: g.repair,
    failedGates: judge ? g.failedGates.filter((x) => x !== 'agent-failed') : [...g.failedGates, 'agent-failed'],
    evidenceChecked: g.evidenceChecked,
    reason: (v && v.reason) || (judge ? 'the judge gave no verdict for this case' : 'the judge returned nothing — deferred, not judged'),
    ...(twinOf(v) !== null ? { duplicateOf: twinOf(v) } : {}),
    ...(coveredByOf(v) ? { coveredBy: coveredByOf(v) } : {}),
  }
  // "Already covered" is itself a factual claim about an existing spec: it needs that spec's file:line.
  if (out.verdict === 'reject' && out.coveredBy && !out.evidenceChecked.some((e) => e.kind === 'file_line')) {
    return {
      ...out, verdict: 'defer',
      failedGates: [...out.failedGates, 'evidence-gate:covered-needs-file_line'],
      missing: [...out.missing, `the e2e/*.spec.ts file:line that already asserts it, cited as file_line evidence (the judge named ${out.coveredBy} without one)`],
    }
  }
  return out
})
// A duplicate may be dropped only beside a licensed twin: a duplicateOf pointing at a case that is
// not accept/qualify (or at no case) becomes a defer naming that twin, so mutual duplicates both
// defer. Checked against the gated verdicts above, so the outcome does not depend on case order.
const settled = gated.map((c) => {
  if (c.verdict !== 'reject' || c.coveredBy || c.duplicateOf === undefined) return c
  const twin = gated[c.duplicateOf - 1]
  if (twin && LICENSING.includes(twin.verdict)) return c
  const why = twin ? `case #${twin.index} ("${twin.title}") is ${twin.verdict}` : `case #${c.duplicateOf} does not exist`
  return {
    ...c, verdict: 'defer',
    failedGates: [...c.failedGates, 'duplicate-of-unlicensed'],
    missing: [...c.missing, `a licensed twin: ${why}, not accept/qualify, so this case is not covered by a returned case`],
  }
})

const cases = settled.filter((c) => LICENSING.includes(c.verdict)) // implement these
const covered = settled.filter((c) => c.verdict === 'reject' && c.coveredBy) // already asserted by an existing spec: no gap
const revised = settled.filter((c) => c.verdict === 'revise')
const deferred = settled.filter((c) => c.verdict === 'defer')
const rejected = settled.filter((c) => c.verdict === 'reject' && !c.coveredBy) // duplicates of a returned case, or unobservable
// A judge that never changes anything (everything accepted) shows up here.
const verdictCounts = tally(settled)
log(`judge: ${judge ? 'ran' : 'no verdict'}; ${cases.length} of ${designed.length} case(s) licensed — ${VERDICTS.map((v) => `${v} ${verdictCounts[v]}`).join(', ')}`)

return { flow, judged: !!judge, count: cases.length, cases, covered, revised, deferred, rejected, failedCategories, verdictCounts }
