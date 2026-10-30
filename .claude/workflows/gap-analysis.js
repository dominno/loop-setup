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

phase('Dimensions')
const results = await parallel(
  DIMENSIONS.map((d, i) => () =>
    agent(
      `Analyze the gap for "${scope}" along this dimension by reading docs/, src/, e2e/, and the story map:\n${d.prompt}\nReturn only gaps backed by concrete references; an empty list is a valid, honest answer.`,
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
const synth = await agent(
  `Given these gaps grouped by dimension, propose the recommended NEXT-implementation order (highest-leverage first), each with a one-line "why". Be concrete.\n\n${JSON.stringify(byDimension)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: ORDER_SCHEMA, model: JUDGE_MODEL },
).catch(agentFailed('synthesize'))
// A dead synthesizer (threw, or returned nothing) does not sink the analysis: the gaps stand,
// unordered, and the order is null with its missing named, never an empty "nothing to do".
const recommendedOrder = synth ? synth.order || [] : null
const missing = synth ? [] : ['a synthesized order — the synthesizer failed (infra); the gaps are listed unordered in byDimension']

return { scope, totalGaps: total, byDimension, failedDimensions, recommendedOrder, missing }
