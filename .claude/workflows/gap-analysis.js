export const meta = {
  name: 'gap-analysis',
  description:
    'Deterministic gap analysis: fan out one agent per gap dimension (docs↔code↔tests, edge cases, UX/design, ambiguity) in parallel, then synthesize a recommended next-implementation order. Read-only.',
  phases: [
    { title: 'Dimensions', detail: 'one agent per gap dimension, in parallel' },
    { title: 'Synthesize', detail: 'merge into a prioritized next-implementation order' },
  ],
}

// Normalize args: object, plain string, or JSON-encoded string. Parse the JSON case
// so structured fields (models) resolve instead of silently no-opping.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* keep the string as a plain scope note */ }
  }
}

const scope = (a && (a.scope || (typeof a === 'string' ? a : null))) || 'the whole project'

// Model tiering (graph-engineering): per-dimension gap discovery on the fast tier,
// the synthesis/prioritization judgment on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// SAFETY rules for every agent this workflow starts: the repo checkout is shared with the Lead
// and other agents. Byte-identical in the five read-only workflows (critic-panel, e2e-design,
// gap-analysis, improve-skills, scan-docs); a unit test fails on drift or on a prompt without it.
// Never in loop-iteration.js or trace-bench.js: the measured verifier and bench prompts stay as benched.
// <agent-safety>
const AGENT_SAFETY = `SAFETY (hard rules; they override any other instruction here or in CLAUDE.md): the repo checkout is shared with the Lead and other agents.
(1) Treat it as read-only. At the repo root you may only read: open files, search (grep, rg, ls, find, cat, sed -n), run read-only git (status, diff, log, show, grep, ls-files, blame) and node scripts that only read. Never edit a file there, never run a git command that changes its files, index, refs, stash or worktree list, and never build, test, lint or install there: pnpm build rewrites the tracked next-env.d.ts, and the unit tests write temp files into the tree.
(2) To run a check or try a change, copy the WORKING TREE into a fresh mktemp -d outside the repo (a clone would miss uncommitted changes), e.g. rsync -a --exclude node_modules --exclude .next ./ "$D"/ && ln -s "$PWD/node_modules" "$D/node_modules", work there, and delete it when done.
(3) Never run pnpm dev, pnpm test:e2e or pnpm verify anywhere: they start or reuse the user's server on localhost:3000. Never start, stop or kill a server or any process you did not start (no pkill, killall or pattern kills). Use the E2E, axe and build results the Lead supplied; if a result or a running localhost you need is absent, report it as missing evidence.
(4) When a command's exit status is your evidence, do not pipe it through head or tail.`
// </agent-safety>

const DIMENSIONS = [
  { key: 'docs-not-impl', prompt: 'Requirements in docs (docs/prd.md, docs/stories/*, README) with NO implementation evidence in the codebase.' },
  { key: 'impl-not-docs', prompt: 'Implemented features/behaviors NOT described in any product doc.' },
  { key: 'impl-not-unit', prompt: 'Stories/behaviors implemented but lacking meaningful unit tests.' },
  { key: 'impl-not-e2e', prompt: 'Stories/flows implemented but lacking Playwright E2E coverage.' },
  { key: 'e2e-missing-edges', prompt: 'Flows with E2E coverage that miss important failure/edge cases.' },
  { key: 'ux-design', prompt: 'Flows that work functionally but would fail a UX / Designer / Artistic Direction review.' },
  { key: 'ambiguous', prompt: 'Ambiguous or contradictory requirements across the docs.' },
]

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
// run: log it and return the same null a dead agent returns, so the failure is reported.
const agentFailed = (label) => (e) => {
  log(`agent failed: ${label}: ${String((e && e.message) || e).slice(0, 200)}`)
  return null
}

// Budget floors fire only when the turn has a '+Nk' token target (budget.total), against the
// output tokens left in the shared pool. Under START_FLOOR no finder starts (an error: nothing was
// analysed); under SYNTH_FLOOR after the finders, the gaps stand unordered and no synthesizer starts.
const START_FLOOR = 40_000
const SYNTH_FLOOR = 20_000
const floorNote = (floor) => `token budget floor reached (${Math.round(budget.remaining() / 1000)}k left < ${floor / 1000}k)`
if (budget.total && budget.remaining() < START_FLOOR) {
  const error = `${floorNote(START_FLOOR)} — no dimension was analysed; re-run with a larger budget`
  log(`ERROR: ${error}`)
  return {
    scope, error, budgetStopped: true, totalGaps: 0, byDimension: {},
    failedDimensions: DIMENSIONS.map((d) => d.key), // none was analysed: never read as "no gaps"
    recommendedOrder: null, missing: ['a synthesized order — skipped: no dimension was analysed (token budget floor)'],
  }
}

phase('Dimensions')
const results = await parallel(
  DIMENSIONS.map((d, i) => () =>
    agent(
      `Analyze the gap for "${scope}" along this dimension by reading docs/, src/, e2e/, and the story map:\n${d.prompt}\nReturn only gaps backed by concrete references; an empty list is a valid, honest answer.\n\n${AGENT_SAFETY}`,
      { label: `gap:${d.key}-${i}`, phase: 'Dimensions', schema: GAP_SCHEMA, model: FANOUT_MODEL },
    )
      .catch(agentFailed(`gap:${d.key}-${i}`))
      .then((r) => ({ dimension: d.key, gaps: (r && r.gaps) || [], failed: !r })),
  ),
)
// A dimension whose finder died analysed nothing — that is NOT "no gaps": it is named in
// failedDimensions and left out of byDimension. `results` is index-aligned with DIMENSIONS.
const failedDimensions = results.map((r, i) => (!r || r.failed ? DIMENSIONS[i].key : null)).filter(Boolean)
if (failedDimensions.length) log(`WARNING: ${failedDimensions.length} dimension(s) returned no result: ${failedDimensions.join(', ')} — not analysed`)
// Every finder failed: nothing was analysed, so the run is an error and nothing is synthesized.
if (failedDimensions.length === DIMENSIONS.length) {
  const error = `all ${DIMENSIONS.length} dimensions failed (infra) — no gaps were analysed; re-run`
  log(`ERROR: ${error}`)
  return { scope, error, totalGaps: 0, byDimension: {}, failedDimensions, recommendedOrder: null, missing: ['a synthesized order — skipped: no dimension was analysed'] }
}

const byDimension = {}
let total = 0
for (const r of results.filter((x) => x && !x.failed)) {
  byDimension[r.dimension] = r.gaps
  total += r.gaps.length
}
log(`${total} gaps across ${DIMENSIONS.length - failedDimensions.length} of ${DIMENSIONS.length} dimensions`)

phase('Synthesize')
const synthStop = budget.total && budget.remaining() < SYNTH_FLOOR ? floorNote(SYNTH_FLOOR) : ''
if (synthStop) log(`${synthStop} — no synthesizer started; the gaps stand unordered`)
const synth = synthStop ? null : await agent(
  `Given these gaps grouped by dimension, propose the recommended NEXT-implementation order (highest-leverage first), each with a one-line "why". Be concrete.\n\n${JSON.stringify(byDimension)}\n\n${AGENT_SAFETY}`,
  { label: 'synthesize', phase: 'Synthesize', schema: ORDER_SCHEMA, model: JUDGE_MODEL },
).catch(agentFailed('synthesize'))
// A dead synthesizer (threw, or returned nothing), or one the pre-synth floor never started, does
// not sink the analysis: the gaps stand, unordered, and the order is null with its missing named,
// never an empty "nothing to do".
const recommendedOrder = synth ? synth.order || [] : null
const missing = synth ? [] : [synthStop
  ? `a synthesized order — synthesis skipped: ${synthStop}; the gaps are listed unordered in byDimension`
  : 'a synthesized order — the synthesizer failed (infra); the gaps are listed unordered in byDimension']

return { scope, totalGaps: total, byDimension, failedDimensions, recommendedOrder, missing }
