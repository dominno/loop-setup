export const meta = {
  name: 'loop-iteration',
  description:
    'Maker/checker for an L2/L3 loop iteration: for each already-triaged, denylist-cleared work item, an implementer subagent (isolated git worktree) applies the smallest safe fix and runs the relevant checks there; a SEPARATE verifier subagent adversarially reviews the reported change and approves or rejects. Returns per-item outcomes; the caller applies approved changes and escalates the rest.',
  phases: [
    { title: 'Implement', detail: 'implementer per item, in an isolated worktree' },
    { title: 'Verify', detail: 'a separate verifier reviews the change and approves/rejects' },
  ],
}

// args.items: [{ id, description }] — already triaged and denylist-cleared by the loop.
const items = (args && args.items) || []
const level = (args && args.level) || 'L2'
if (!items.length) {
  return { error: 'No work items. Triage + denylist-check first, then pass args.items = [{id, description}].', applied: [], rejected: [] }
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changedFiles', 'diffSummary', 'checksPassed', 'notes'],
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' } },
    diffSummary: { type: 'string' },
    checksPassed: { type: 'boolean', description: 'did the smallest relevant checks pass in the worktree' },
    notes: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'reason'],
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

// Pipeline: each item flows implement → verify independently.
const outcomes = await pipeline(
  items,
  (item) =>
    agent(
      `Implement the SMALLEST safe fix for this loop work item and run the smallest relevant checks (tests/typecheck/lint). Stay in scope; NEVER touch denylist paths (auth, payments, secrets/.env, infra, CI config, migrations). Report the changed files, a diff summary, and whether the checks passed.\n\n${JSON.stringify(item)}`,
      { label: `impl:${item.id}`, phase: 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree' },
    ),
  (impl, item) =>
    agent(
      `You are a SEPARATE verifier (not the implementer). Adversarially review this proposed change for correctness, scope creep, denylist violations, and whether its "checksPassed" claim is credible. Default to pass:false if you cannot confirm it is safe and correct.\n\nItem: ${JSON.stringify(item)}\nProposed change: ${JSON.stringify(impl)}`,
      { label: `verify:${item.id}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({
      id: item.id,
      // Fail safe: no verdict / verifier died → not approved.
      applied: !!(v && v.pass),
      status: v && v.pass ? 'applied' : 'rejected',
      changedFiles: (impl && impl.changedFiles) || [],
      diffSummary: impl && impl.diffSummary,
      checksPassed: !!(impl && impl.checksPassed),
      verdict: (v && v.reason) || 'verifier returned no verdict — rejected',
    })),
)

const settled = outcomes.filter(Boolean)
const applied = settled.filter((o) => o.applied)
const rejected = settled.filter((o) => !o.applied)
return { level, applied, rejected, escalate: rejected.map((o) => o.id) }
