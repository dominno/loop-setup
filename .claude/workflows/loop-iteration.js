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
  type: 'object', additionalProperties: false, required: ['changedFiles', 'diff', 'checksPassed', 'notes'],
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' } },
    // The ACTUAL unified diff (from `git diff` in the worktree) — the durable
    // artifact the verifier reviews and the caller applies. Not a prose summary.
    diff: { type: 'string', description: 'the real unified diff / patch text (git diff output)' },
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

// Defense-in-depth: a hard, deterministic denylist gate on the actual changed
// files — independent of the verifier's judgment. Any match forces escalation.
const DENYLIST = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)auth(\/|\.|$)/i, /payment/i, /secret/i,
  /(^|\/)migrations?(\/|$)/i, /\.github\/workflows\//i, /(^|\/)(infra|deploy)(\/|$)/i,
]
const hitsDenylist = (files) => (files || []).some((f) => DENYLIST.some((re) => re.test(f)))

phase('Implement')
// Pipeline: each item flows implement → verify independently.
const outcomes = await pipeline(
  items,
  (item, i) =>
    agent(
      `Implement the SMALLEST safe fix for this loop work item in your isolated worktree and run the smallest relevant checks (tests/typecheck/lint). Stay in scope; NEVER touch denylist paths (auth, payments, secrets/.env, infra, CI config, migrations). Then capture the ACTUAL change with \`git diff\` and return it as \`diff\` (the real patch, not a summary), the changed files, and whether the checks passed.\n\n${JSON.stringify(item)}`,
      { label: `impl:${item.id || 'item'}-${i}`, phase: 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree' },
    ),
  (impl, item, i) => {
    const im = impl || {}
    // Hard denylist gate — independent of the verifier.
    if (hitsDenylist(im.changedFiles)) {
      return {
        id: item.id, applied: false, status: 'escalated-denylist',
        changedFiles: im.changedFiles || [], diff: im.diff || '', checksPassed: !!im.checksPassed,
        verdict: 'changed files match the denylist — forced escalation regardless of verdict',
      }
    }
    return agent(
      `You are a SEPARATE verifier (not the implementer). Adversarially review the ACTUAL diff below for correctness, scope creep, and denylist violations, and judge whether the change is safe to apply. Default to pass:false if you cannot confirm it from the diff.\n\nItem: ${JSON.stringify(item)}\nChanged files: ${JSON.stringify(im.changedFiles || [])}\nchecksPassed (self-reported): ${!!im.checksPassed}\nDiff:\n${im.diff || '(no diff returned)'}`,
      { label: `verify:${item.id || 'item'}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({
      id: item.id,
      // Fail safe: no verdict / verifier died → not approved.
      applied: !!(v && v.pass),
      status: v && v.pass ? 'applied' : 'rejected',
      changedFiles: im.changedFiles || [],
      diff: im.diff || '', // the patch the caller applies for approved items
      checksPassed: !!im.checksPassed,
      verdict: (v && v.reason) || 'verifier returned no verdict — rejected',
    }))
  },
)

const settled = outcomes.filter(Boolean)
const applied = settled.filter((o) => o.applied)
const rejected = settled.filter((o) => !o.applied)
// Approved items carry their `diff` — the caller applies the patch (worktrees are
// ephemeral) and re-runs the smallest relevant checks before committing.
return { level, applied, rejected, escalate: rejected.map((o) => o.id) }
