export const meta = {
  name: 'gap-analysis',
  description:
    'Deterministic gap analysis: fan out one agent per gap dimension (docs↔code↔tests, edge cases, UX/design, ambiguity) in parallel, then synthesize a recommended next-implementation order. Read-only.',
  phases: [
    { title: 'Dimensions', detail: 'one agent per gap dimension, in parallel' },
    { title: 'Synthesize', detail: 'merge into a prioritized next-implementation order' },
  ],
}

const scope = (args && (args.scope || (typeof args === 'string' ? args : null))) || 'the whole project'

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

phase('Dimensions')
const results = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(
      `Analyze the gap for "${scope}" along this dimension by reading docs/, src/, e2e/, and the story map:\n${d.prompt}\nReturn only gaps backed by concrete references; an empty list is a valid, honest answer.`,
      { label: `gap:${d.key}`, phase: 'Dimensions', schema: GAP_SCHEMA },
    ).then((r) => ({ dimension: d.key, gaps: (r && r.gaps) || [] })),
  ),
)

const byDimension = {}
let total = 0
for (const r of results.filter(Boolean)) {
  byDimension[r.dimension] = r.gaps
  total += r.gaps.length
}
log(`${total} gaps across ${DIMENSIONS.length} dimensions`)

phase('Synthesize')
const synth = await agent(
  `Given these gaps grouped by dimension, propose the recommended NEXT-implementation order (highest-leverage first), each with a one-line "why". Be concrete.\n\n${JSON.stringify(byDimension)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: ORDER_SCHEMA },
)

return { scope, totalGaps: total, byDimension, recommendedOrder: (synth && synth.order) || [] }
