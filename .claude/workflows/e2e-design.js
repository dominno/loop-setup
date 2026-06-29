export const meta = {
  name: 'e2e-design',
  description:
    'Deterministic E2E test design: fan out one agent per path category (happy, failure, edge, accessibility, regression) to enumerate concrete Playwright test cases for a flow, then dedup. The caller implements the cases.',
  phases: [{ title: 'Design', detail: 'one agent per path category enumerates test cases in parallel' }],
}

const flow = (args && (args.flow || (typeof args === 'string' ? args : null))) || 'the target flow'

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

phase('Design')
const results = await parallel(
  CATEGORIES.map((c) => () =>
    agent(
      `Enumerate concrete Playwright E2E test cases for "${flow}" covering ${c.prompt}. Inspect the routes/components and existing specs first. Each case needs: title, steps, and the visible expected outcome to assert.`,
      { label: `e2e:${c.key}`, phase: 'Design', schema: CASES_SCHEMA },
    ).then((r) => ((r && r.cases) || []).map((x) => ({ ...x, category: c.key }))),
  ),
)

const all = results.filter(Boolean).flat()
const seen = new Set()
const cases = all.filter((c) => {
  // Key on category + title so a failure-path case isn't dropped for sharing a
  // title with a happy-path case.
  const k = `${c.category}::${String(c.title || '').trim().toLowerCase()}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
log(`${cases.length} test cases (${all.length} before dedup) for "${flow}"`)

return { flow, count: cases.length, cases }
