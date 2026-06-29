export const meta = {
  name: 'critic-panel',
  description:
    'Deterministic multi-agent critic round: fan out the critics as parallel subagents (each in its own context), adversarially verify every blocker/important finding with a separate skeptic, then return a synthesized severity matrix.',
  phases: [
    { title: 'Review', detail: 'each critic reviews independently, in its own context' },
    { title: 'Verify', detail: 'a separate skeptic tries to refute each blocker/important finding' },
  ],
}

// What to review (focus) + how deep, passed via the Workflow `args`.
const focus =
  (args && (args.focus || (typeof args === 'string' ? args : null))) ||
  'the current app/flow and the changed files'

// The standard critic roster. UI-facing critics should drive the running app via
// Playwright/Chrome MCP (reachable through ToolSearch) when a localhost flow exists.
const CRITICS = [
  { key: 'first-time-user', label: 'First-Time User Critic', lens: 'Can a new user understand the first screen and complete the flow without help? Labels, errors, hidden assumptions.' },
  { key: 'ux-flow', label: 'UX Flow Critic', lens: 'Beginning/middle/end of the journey, feedback on every action, confirm destructive actions, loading/success/recovery states.' },
  { key: 'designer', label: 'Designer Critic', lens: 'Layout hierarchy, spacing, alignment, typography, color, button/empty/loading/error states, mobile responsiveness.' },
  { key: 'artistic-direction', label: 'Artistic Direction Critic', lens: 'Mood, visual identity, beauty, coherence — is it intentional and memorable or generic?' },
  { key: 'frontend-arch', label: 'Frontend Architecture Critic', lens: 'Component boundaries, state, hooks, server/client split, TypeScript correctness, SOLID/DRY/KISS, no duplicated logic.' },
  { key: 'qa-e2e', label: 'QA / E2E Critic', lens: 'Critical paths, missing Playwright tests, meaningful vs superficial assertions, edge cases, did we actually verify localhost?' },
  { key: 'accessibility', label: 'Accessibility Critic', lens: 'Keyboard nav, focus states, accessible names, labels, form-error linkage, contrast, semantic HTML, dialog a11y.' },
  { key: 'performance', label: 'Performance Critic', lens: 'Unnecessary re-renders, large client bundles, heavy images, blocking fetches, overuse of client components.' },
  { key: 'security', label: 'Security Critic', lens: 'Unsafe input handling, secrets exposed to the client, auth-bypass risk, missing server-side validation, unsafe redirects, XSS, insecure storage.' },
  { key: 'regression', label: 'Regression Critic', lens: 'Existing routes/flows affected, shared components/APIs changed, snapshots, styling side effects, backward compatibility.' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'evidence', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'important', 'nice-to-have'] },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'Concrete observation: file:line, command output, or browser observation.' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true if the finding is genuine after attempting to refute it' },
    reason: { type: 'string' },
  },
}

// Phase 1 — every critic reviews independently and in parallel (a barrier: we want
// the full set before deduping and verifying).
phase('Review')
const reviews = await parallel(
  CRITICS.map((c) => () =>
    agent(
      `You are the **${c.label}** for this project. Read CLAUDE.md and the relevant memory topic page(s), inspect ${focus} (read the code; if a localhost flow is in scope, drive it via Playwright/Chrome MCP and check console + network), then review strictly through your lens:\n${c.lens}\n\nReturn only findings you can back with concrete evidence. An empty list is a valid, honest answer.`,
      { label: `critic:${c.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ).then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [] })),
  ),
)

// Flatten + light dedup (same severity + near-same title) across critics.
const all = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, critic: r.critic, criticLabel: r.label })))
const seen = new Set()
const deduped = all.filter((f) => {
  const k = `${f.severity}::${f.title.trim().toLowerCase()}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
log(`${deduped.length} findings from ${CRITICS.length} critics (${all.length} before dedup)`)

// Phase 2 — adversarially verify each blocker/important finding with a SEPARATE
// skeptic agent (the reviewer never confirms its own finding). Nice-to-haves are
// recorded as-is, not verified.
phase('Verify')
const toVerify = deduped.filter((f) => f.severity === 'blocker' || f.severity === 'important')
const verified = await parallel(
  toVerify.map((f, i) => () =>
    agent(
      `Adversarially verify this ${f.severity} finding from the ${f.criticLabel}. Try to REFUTE it by inspecting the actual code/flow — default to real:false if the evidence does not hold up.\n\nTitle: ${f.title}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
      { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({
      ...f,
      // Fail safe: a missing/failed verdict must NOT confirm the finding.
      real: v ? v.real : false,
      verifyReason: (v && v.reason) || 'verifier returned no verdict — not confirmed',
    })),
  ),
)

const niceToHaves = deduped.filter((f) => f.severity === 'nice-to-have')
const confirmed = verified.filter((f) => f.real !== false)
const refuted = verified.filter((f) => f.real === false)

return {
  focus,
  counts: {
    critics: CRITICS.length,
    confirmedBlockers: confirmed.filter((f) => f.severity === 'blocker').length,
    confirmedImportant: confirmed.filter((f) => f.severity === 'important').length,
    niceToHave: niceToHaves.length,
    refuted: refuted.length,
  },
  confirmed, // verified blocker/important findings — the actionable matrix
  niceToHaves, // recorded only
  refuted, // findings a skeptic could not substantiate
}
