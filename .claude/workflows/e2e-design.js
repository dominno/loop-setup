export const meta = {
  name: 'e2e-design',
  description:
    'Deterministic E2E test design: fan out one agent per path category (happy, failure, edge, accessibility, regression) to enumerate concrete Playwright test cases for a flow, then dedup. The caller implements the cases.',
  phases: [{ title: 'Design', detail: 'one agent per path category enumerates test cases in parallel' }],
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

// Model tiering (graph-engineering): this workflow is pure fan-out enumeration
// (the dedup is plain code, not an agent), so every node runs on the fast tier.
// Override via args.models.fanout.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'

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

// An agent() that throws (token budget spent, harness error) is a FAILED agent, not a crashed
// run: log it and return the same null a dead agent returns, so the category is reported.
const agentFailed = (label) => (e) => {
  log(`agent failed: ${label}: ${String((e && e.message) || e).slice(0, 200)}`)
  return null
}

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
if (failedCategories.length === CATEGORIES.length) {
  const error = `all ${CATEGORIES.length} path categories failed (infra) — no cases were designed; re-run`
  log(`ERROR: ${error}`)
  return { flow, error, failedCategories, count: 0, cases: [] }
}

const all = results.filter(Boolean).flatMap((r) => r.cases)
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

return { flow, failedCategories, count: cases.length, cases }
