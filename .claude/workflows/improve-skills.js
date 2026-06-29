export const meta = {
  name: 'improve-skills',
  description:
    "Deterministic meta-critic over the project's OWN prompts and orchestration: fan out one reviewer per quality lens across the command/workflow/instruction surface (.claude/commands/*.md, .claude/workflows/*.js, CLAUDE.md, skills-index, loop files), adversarially verify each blocker/important finding with a separate skeptic, and return PROPOSED edits. The caller applies them only on confirmation — this workflow never writes files.",
  phases: [
    { title: 'Review', detail: 'one meta-critic per lens reviews the prompt/workflow surface' },
    { title: 'Verify', detail: 'a separate skeptic refutes each finding AND its proposed edit' },
  ],
}

// Optional focus note + explicit target list, passed via the Workflow `args`.
const scope =
  (args && (args.scope || (typeof args === 'string' ? args : null))) ||
  'all custom prompts, skills, and workflow orchestration in this repo'
// The default prompt surface to review. Callers can pass args.targets to scope it.
const DEFAULT_TARGETS = [
  '.claude/commands/*.md',
  '.claude/workflows/*.js',
  'CLAUDE.md',
  '.claude/skills-index.md',
  '.claude/memory/index.md',
  '.claude/loop.md',
  '.claude/loop-checklist.md',
]
const targets = (args && Array.isArray(args.targets) && args.targets.length ? args.targets : DEFAULT_TARGETS)
const targetList = targets.join(', ')

// Meta-critic lenses — each reviews the SYSTEM'S OWN instructions, not product code.
// `code: true` lenses focus on the workflow .js orchestration; the rest on prose prompts.
const LENSES = [
  { key: 'clarity', code: false, label: 'Clarity & Actionability Critic', lens: 'Is every instruction unambiguous and written as an imperative the agent will actually follow? Flag vague/hedged steps, undefined terms, missing acceptance criteria, and steps with no checkable outcome.' },
  { key: 'instruction-following', code: false, label: 'Instruction-Following Risk Critic', lens: 'Where would an LLM plausibly misread, skip, or over-comply? Conflicting directives, a critical rule buried mid-paragraph, ambiguous ordering, "should" where "must" is meant, or prompts so long the key constraint is lost.' },
  { key: 'safety-gating', code: false, label: 'Safety & Gating Critic', lens: 'Are destructive or auto-applied actions properly confirmation-gated and denylist-aware? Flag any prompt that could auto-create/rewrite/delete files, commit/push, or self-modify core prompts WITHOUT an explicit confirmation gate. This is the most important lens for a self-improving system.' },
  { key: 'consistency-dry', code: false, label: 'Consistency & DRY Critic', lens: 'Contradictions or duplication ACROSS CLAUDE.md, the commands, skills-index.md, and the memory wiki. Flag facts/lists stated in multiple places that can drift apart (single-source-of-truth risk), and any command whose body contradicts CLAUDE.md or the wiki.' },
  { key: 'workflow-dsl', code: true, label: 'Workflow DSL & Schema Critic', lens: 'For .claude/workflows/*.js only: fail-safe verifiers (a null/failed verdict must NOT confirm), unique agent labels that include the map index, guarded first pipeline stage before deref, fail-closed defaults, maker/checker given the REAL artifact (not a self-report), valid JSON Schemas, and a meta block that is a pure literal. Flag deviations.' },
  { key: 'routing', code: false, label: 'Routing & Discoverability Critic', lens: 'Does each command have a one-line description (for model routing) and a matching skills-index row? Flag near-duplicate commands, dead index rows, missing argument-hints, and heavy/code-changing commands that lack disable-model-invocation where they should be manual-only.' },
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
        required: ['severity', 'file', 'title', 'evidence', 'proposedEdit'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'important', 'nice-to-have'] },
          file: { type: 'string', description: 'the prompt/workflow file the finding is about (path), or "(cross-file)"' },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'concrete quote or file:line from the prompt being reviewed' },
          proposedEdit: { type: 'string', description: 'the concrete change to make — what to change to what (before → after), specific enough for the caller to apply' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'editSafe', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true if the problem is genuine after trying to refute it' },
    editSafe: { type: 'boolean', description: 'true if the proposed edit is a real improvement that would NOT weaken instruction-following, safety gating, or break the workflow' },
    reason: { type: 'string' },
  },
}

// Phase 1 — every meta-critic reviews the prompt surface independently, in parallel
// (a barrier: we want the full set before deduping and verifying).
phase('Review')
const reviews = await parallel(
  LENSES.map((c) => () =>
    agent(
      `You are the **${c.label}** auditing this project's OWN Claude Code configuration — its custom prompts, skills, and multi-agent orchestration. You are NOT reviewing product/application code; you are reviewing the instructions that drive the agent.\n\nRead these files (the prompt surface): ${targetList}\n${c.code ? 'Focus on the workflow orchestration scripts (.claude/workflows/*.js).' : 'Focus on the prose prompts (commands, CLAUDE.md, skills-index, loop files).'}\n\nReview strictly through your lens:\n${c.lens}\n\nScope: ${scope}\n\nFor each issue return concrete evidence (a quote or file:line) AND a specific proposedEdit (what to change to what). Propose improvements to the prompts/workflows themselves — do not propose product-code changes. An empty list is a valid, honest answer.`,
      { label: `meta:${c.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ).then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [] })),
  ),
)

// Flatten, then dedup on (severity + file + exact normalized title). On a collision,
// MERGE (keep the corroborating critic + evidence) rather than dropping — two critics
// agreeing is a stronger signal, not a duplicate.
const all = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, critic: r.critic, criticLabel: r.label })))
const byKey = new Map()
for (const f of all) {
  const k = `${f.severity}::${String(f.file || '').trim().toLowerCase()}::${String(f.title || '').trim().toLowerCase()}`
  const existing = byKey.get(k)
  if (existing) {
    existing.alsoFlaggedBy = existing.alsoFlaggedBy || []
    existing.alsoFlaggedBy.push({ critic: f.critic, evidence: f.evidence })
  } else {
    byKey.set(k, { ...f })
  }
}
const deduped = [...byKey.values()]
log(`${deduped.length} findings from ${LENSES.length} meta-critics (${all.length} before merge-dedup)`)

// Phase 2 — adversarially verify each blocker/important finding with a SEPARATE
// skeptic. It must refute BOTH that the problem is real AND that the proposed edit is
// a safe improvement (so we never "improve" a prompt into being weaker or less safe).
phase('Verify')
const toVerify = deduped.filter((f) => f.severity === 'blocker' || f.severity === 'important')
const verified = await parallel(
  toVerify.map((f, i) => () =>
    agent(
      `You are a SEPARATE skeptic (not the critic who raised this). Read the actual file and try to REFUTE this ${f.severity} finding about the project's own prompts/workflows.\n\nJudge two things independently:\n1. real — is the problem genuine? Default real:false if the evidence does not hold up.\n2. editSafe — would the proposed edit be a real improvement that does NOT weaken instruction-following, remove a safety/confirmation gate, or break a workflow? Default editSafe:false if you cannot confirm it is safe.\n\nFile: ${f.file}\nTitle: ${f.title}\nEvidence: ${f.evidence}\nProposed edit: ${f.proposedEdit}`,
      { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({
      ...f,
      // Fail safe: a missing/failed verdict must NOT confirm the finding or its edit.
      real: v ? v.real : false,
      editSafe: v ? v.editSafe : false,
      verifyReason: (v && v.reason) || 'verifier returned no verdict — not confirmed',
    })),
  ),
)

const niceToHaves = deduped.filter((f) => f.severity === 'nice-to-have')
const settled = verified.filter(Boolean)
// Actionable = the problem is real. `applyReady` additionally requires the edit to be
// verified safe — the caller applies those first and treats real-but-not-editSafe
// findings as "needs a human-designed fix".
const confirmed = settled.filter((f) => f.real !== false)
const applyReady = confirmed.filter((f) => f.editSafe === true)
const needsDesign = confirmed.filter((f) => f.editSafe !== true)
const refuted = settled.filter((f) => f.real === false)

return {
  scope,
  targets,
  counts: {
    lenses: LENSES.length,
    confirmedBlockers: confirmed.filter((f) => f.severity === 'blocker').length,
    confirmedImportant: confirmed.filter((f) => f.severity === 'important').length,
    applyReady: applyReady.length,
    needsDesign: needsDesign.length,
    niceToHave: niceToHaves.length,
    refuted: refuted.length,
  },
  applyReady, // real problem + verified-safe edit → caller proposes these for confirmation
  needsDesign, // real problem, edit not confirmed safe → needs a human-designed fix
  niceToHaves, // recorded only, not verified
  refuted, // a skeptic could not substantiate these
}
