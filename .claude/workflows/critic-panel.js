export const meta = {
  name: 'critic-panel',
  description:
    'Deterministic multi-agent critic round: fan out the critics as parallel subagents (each in its own context), adversarially verify every blocker/important finding with a separate skeptic, then return a synthesized severity matrix.',
  phases: [
    { title: 'Review', detail: 'each critic reviews independently, in its own context' },
    { title: 'Verify', detail: 'a separate skeptic tries to refute each blocker/important finding' },
  ],
}

// Normalize args: the Workflow tool may hand args as an object, a plain string, or a
// JSON-encoded string. Parse the JSON-string case so structured fields (models,
// priorEvidence, uiInScope) resolve instead of silently no-opping.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* keep the string as a plain focus note */ }
  }
}

// What to review (focus) + how deep, passed via the Workflow `args`.
const focus =
  (a && (a.focus || (typeof a === 'string' ? a : null))) ||
  'the current app/flow and the changed files'
// Optional: evidence the Lead already gathered (test/lint/build output, browser
// findings, git diff). Critics verify against it instead of re-deriving from scratch.
const priorEvidence = (a && a.priorEvidence) || null
// Optional: skip the 5 UI/browser critics for non-UI (backend/docs/config) changes.
// Defaults to including them (safe). Callers pass `uiInScope: false` to save fan-out.
const uiInScope = !(a && a.uiInScope === false)

// Model tiering (graph-engineering): high-volume fan-out on the fast tier, the
// high-stakes adversarial gate on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// The standard critic roster. `ui: true` marks browser-facing critics.
const ALL_CRITICS = [
  { key: 'first-time-user', ui: true, label: 'First-Time User Critic', lens: 'Can a new user understand the first screen and complete the flow without help? Labels, errors, hidden assumptions.' },
  { key: 'ux-flow', ui: true, label: 'UX Flow Critic', lens: 'Beginning/middle/end of the journey, feedback on every action, confirm destructive actions, loading/success/recovery states.' },
  { key: 'designer', ui: true, label: 'Designer Critic', lens: 'Layout hierarchy, spacing, alignment, typography, color, button/empty/loading/error states, mobile responsiveness.' },
  { key: 'artistic-direction', ui: true, label: 'Artistic Direction Critic', lens: 'Mood, visual identity, beauty, coherence — is it intentional and memorable or generic?' },
  { key: 'frontend-arch', ui: false, label: 'Frontend Architecture Critic', lens: 'Component boundaries, state, hooks, server/client split, TypeScript correctness, SOLID/DRY/KISS, no duplicated logic.' },
  { key: 'qa-e2e', ui: false, label: 'QA / E2E Critic', lens: 'Critical paths, missing Playwright tests, meaningful vs superficial assertions, edge cases, did we actually verify localhost?' },
  { key: 'accessibility', ui: true, label: 'Accessibility Critic', lens: 'Keyboard nav, focus states, accessible names, labels, form-error linkage, contrast, semantic HTML, dialog a11y.' },
  { key: 'performance', ui: false, label: 'Performance Critic', lens: 'Unnecessary re-renders, large client bundles, heavy images, blocking fetches, overuse of client components.' },
  { key: 'security', ui: false, label: 'Security Critic', lens: 'Unsafe input handling, secrets exposed to the client, auth-bypass risk, missing server-side validation, unsafe redirects, XSS, insecure storage.' },
  { key: 'regression', ui: false, label: 'Regression Critic', lens: 'Existing routes/flows affected, shared components/APIs changed, snapshots, styling side effects, backward compatibility.' },
]
const CRITICS = ALL_CRITICS.filter((c) => uiInScope || !c.ui)

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
  CRITICS.map((c, i) => () =>
    agent(
      `You are the **${c.label}** for this project. Read CLAUDE.md and the relevant memory topic page(s), inspect ${focus} (read the code; if a localhost flow is in scope, drive it via Playwright/Chrome MCP and check console + network), then review strictly through your lens:\n${c.lens}\n${priorEvidence ? `\nEvidence already gathered by the Lead — verify against it instead of re-deriving from scratch:\n${typeof priorEvidence === 'string' ? priorEvidence : JSON.stringify(priorEvidence)}\n` : ''}\nReturn only findings you can back with concrete evidence. An empty list is a valid, honest answer.`,
      { label: `critic:${c.key}-${i}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: FANOUT_MODEL },
    ).then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [] })),
  ),
)

// Flatten, then dedup on (severity + exact normalized title). On a collision, MERGE
// (keep the corroborating critic + its evidence) rather than dropping it — two
// critics agreeing is a stronger signal, not a duplicate to discard.
const all = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, critic: r.critic, criticLabel: r.label })))
const byKey = new Map()
for (const f of all) {
  const k = `${f.severity}::${String(f.title || '').trim().toLowerCase()}`
  const existing = byKey.get(k)
  if (existing) {
    existing.alsoFlaggedBy = existing.alsoFlaggedBy || []
    existing.alsoFlaggedBy.push({ critic: f.critic, evidence: f.evidence })
  } else {
    byKey.set(k, { ...f })
  }
}
const deduped = [...byKey.values()]
log(`${deduped.length} findings from ${CRITICS.length} critics (${all.length} before merge-dedup)`)

// Phase 2 — adversarially verify each blocker/important finding with a SEPARATE
// skeptic agent (the reviewer never confirms its own finding). Nice-to-haves are
// recorded as-is, not verified.
phase('Verify')
const toVerify = deduped.filter((f) => f.severity === 'blocker' || f.severity === 'important')
const verified = await parallel(
  toVerify.map((f, i) => () =>
    agent(
      `Adversarially verify this ${f.severity} finding from the ${f.criticLabel}. Try to REFUTE it by inspecting the actual code/flow — default to real:false if the evidence does not hold up.\n\nTitle: ${f.title}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
      { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
    ).then((v) => ({
      ...f,
      // Fail safe: a missing/failed verdict must NOT confirm the finding.
      real: v ? v.real : false,
      verifyReason: (v && v.reason) || 'verifier returned no verdict — not confirmed',
    })),
  ),
)

const niceToHaves = deduped.filter((f) => f.severity === 'nice-to-have')
const settled = verified.filter(Boolean)
const confirmed = settled.filter((f) => f.real !== false)
const refuted = settled.filter((f) => f.real === false)

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
