export const meta = {
  name: 'critic-panel',
  description:
    'Deterministic multi-agent critic round: fan out the critics as parallel subagents (each in its own context, each typing its claims; a code-only round uses one all-lens reviewer instead), adversarially adjudicate every blocker/important finding with a separate skeptic that returns a typed TRACE verdict (accept/qualify/revise/defer/reject) held to the claim type evidence standard, reuse unchanged prior verdicts, then return a synthesized matrix plus TRACE-lite record drafts.',
  phases: [
    { title: 'Review', detail: 'each critic reviews independently, in its own context, and types each claim (a code-only round: one all-lens reviewer)' },
    { title: 'Verify', detail: 'a separate skeptic adjudicates each blocker/important claim; a deterministic evidence gate caps overclaims' },
  ],
}

// Normalize args: the Workflow tool may hand args as an object, a plain string, or a
// JSON-encoded string. Parse the JSON-string case so structured fields (models,
// priorEvidence, uiInScope, priorRecords, treeId) resolve instead of silently no-opping.
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
// Optional (TRACE verdict reuse): the latest prior critic-panel records
// (`pnpm -s trace query --latest --writer critic-panel --brief`) and the working-tree
// fingerprint (`pnpm -s trace tree-id` — HEAD *plus* uncommitted changes, so an edited
// but uncommitted file never looks unchanged). A finding that revisits a prior record as
// "still-present" on an IDENTICAL tree reuses that verdict instead of re-verifying it.
const priorRecords = Array.isArray(a && a.priorRecords) ? a.priorRecords.filter((r) => r && r.record_id) : []
const priorById = new Map(priorRecords.map((r) => [r.record_id, r]))
const treeId = (a && typeof a.treeId === 'string' && /^[0-9a-f]{16}$/.test(a.treeId) && a.treeId) || null

// Model tiering (graph-engineering): high-volume fan-out on the fast tier, the
// high-stakes adversarial gate on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// TRACE-lite evidence gate — byte-identical copy of the canonical block in
// scripts/trace/lib.mjs (workflows cannot import; a unit test fails on drift).
// <trace-evidence-gate>
const VERDICTS = ["accept", "qualify", "revise", "defer", "reject"];
const EVIDENCE_POLICY = {
  factual: { acceptNeeds: ["file_line", "command", "browser", "measurement", "diff"], onFail: "defer", missing: "a file:line, diff, command output, or browser observation that reproduces it" },
  measured: { acceptNeeds: ["measurement"], onFail: "defer", missing: "an actual measurement against the quality bar (axe run, pnpm check:bundle) — reading code is not a measurement" },
  causal: { acceptNeeds: ["command", "browser", "measurement"], onFail: "qualify", qualifier: "supported by code reading only — not demonstrated by an executed test, command, or browser repro" },
  predictive: { acceptNeeds: ["browser", "human"], onFail: "qualify", qualifier: "a prediction about users — not yet observed in the browser or by a human" },
  normative: { acceptNeeds: ["rule", "human"], onFail: "defer", missing: "the named rule or standard it violates (CLAUDE.md, quality-bar.md, WCAG, a project convention)" },
  practical: { acceptNeeds: ["diff"], onFail: "defer", missing: "the real diff of the change being licensed" },
};
function applyEvidenceGate(v) {
  const src = v || {};
  const out = {
    verdict: VERDICTS.includes(src.verdict) ? src.verdict : "defer",
    claimType: EVIDENCE_POLICY[src.claimType] ? src.claimType : "factual",
    evidenceChecked: Array.isArray(src.evidenceChecked) ? src.evidenceChecked.filter((e) => e && e.kind && e.ref) : [],
    failedGates: Array.isArray(src.failedGates) ? src.failedGates.filter(Boolean) : [],
    missing: Array.isArray(src.missing) ? src.missing.filter(Boolean) : [],
    repair: typeof src.repair === "string" ? src.repair : "",
    qualifier: typeof src.qualifier === "string" ? src.qualifier : "",
  };
  if (!VERDICTS.includes(src.verdict)) {
    out.failedGates.push("verdict-missing");
    out.missing.push("a verdict from the checker (none, or an unknown value, was returned)");
  }
  if (!EVIDENCE_POLICY[src.claimType]) out.failedGates.push(`claim-type-unknown:${src.claimType}`);
  const kinds = new Set(out.evidenceChecked.map((e) => e.kind));
  const rule = EVIDENCE_POLICY[out.claimType];
  // Both licensing verdicts face the floor: a checker cannot dodge it by self-demoting
  // to qualify. Only types whose fallback IS qualify (causal, predictive) may qualify on
  // weaker evidence; for the rest a qualify without the needed kind becomes defer.
  const licensing = out.verdict === "accept" || out.verdict === "qualify";
  if (licensing && !rule.acceptNeeds.some((k) => kinds.has(k)) && (out.verdict === "accept" || rule.onFail !== "qualify")) {
    out.failedGates.push(`evidence-gate:${out.claimType}:${out.verdict}-needs-${rule.acceptNeeds.join("|")}`);
    out.verdict = rule.onFail;
    if (rule.onFail === "qualify") out.qualifier = out.qualifier || rule.qualifier;
    else out.missing.push(rule.missing);
  }
  if (out.verdict === "qualify" && kinds.size === 0) {
    out.failedGates.push("evidence-gate:qualify-needs-evidence");
    out.verdict = "defer";
    out.missing.push("any concrete evidence (the checker cited none)");
  }
  if (out.verdict === "qualify" && !out.qualifier) out.qualifier = "qualified by the checker (no qualifier text given)";
  if (out.verdict === "defer" && out.missing.length === 0) {
    out.failedGates.push("defer-without-missing");
    out.missing.push("unspecified — the checker deferred without naming the missing evidence");
  }
  if (out.verdict === "revise" && !out.repair) {
    out.failedGates.push("revise-without-repair");
    out.repair = "unspecified — the checker asked for a revision without stating it";
  }
  return out;
}
// Re-typing must never lower the bar: gate the verdict under every candidate type (the
// maker's and the checker's) and keep the most conservative outcome.
function applyEvidenceGateStrict(v, claimTypes) {
  const types = (claimTypes || []).filter((t, i, all) => EVIDENCE_POLICY[t] && all.indexOf(t) === i);
  if (types.length < 2) return applyEvidenceGate(types.length ? { ...(v || {}), claimType: types[0] } : v);
  const rank = (r) => (r.verdict === "accept" ? 2 : r.verdict === "qualify" ? 1 : 0);
  return types.map((t) => applyEvidenceGate({ ...(v || {}), claimType: t })).reduce((a, b) => (rank(b) < rank(a) ? b : a));
}
// </trace-evidence-gate>
const LICENSING = ['accept', 'qualify']

// The claim types a critic may assert (`practical` is for apply-this-change claims made
// by loop-iteration / improve-skills, not for critic findings). Definitions here; the
// evidence each type needs comes from EVIDENCE_POLICY above (single source of truth).
const CLAIM_TYPE_DEFS = {
  factual: 'an observable fact about the code/app right now (a missing label, an uncovered path)',
  measured: 'a number against a declared bar (contrast ratio, axe violations, bundle KB)',
  causal: 'X causes / will cause Y (a regression, a bug, a re-render cost)',
  predictive: 'how users will behave or feel (confusion, missed affordance)',
  normative: 'violates a named rule or convention (CLAUDE.md, quality-bar.md, WCAG, project style)',
}
const CRITIC_CLAIM_TYPES = Object.keys(CLAIM_TYPE_DEFS)
const EVIDENCE_KINDS = ['file_line', 'command', 'browser', 'measurement', 'rule', 'diff', 'reading', 'record', 'human']
const claimTypeGuide = CRITIC_CLAIM_TYPES.map(
  (t) => `- ${t}: ${CLAIM_TYPE_DEFS[t]}. An accept needs evidence of kind ${EVIDENCE_POLICY[t].acceptNeeds.join('/')}; otherwise it is capped at ${EVIDENCE_POLICY[t].onFail}.`,
).join('\n')

// The standard critic roster. `ui: true` marks browser-facing critics. `cq` = the
// critical questions (Walton-style) the skeptic must put to a finding from this lens —
// refutation becomes a checklist, not improvisation. Byte-identical copy in
// .claude/workflows/trace-bench.js (a unit test fails on drift).
// <critic-roster>
const ALL_CRITICS = [
  { key: 'first-time-user', ui: true, label: 'First-Time User Critic', lens: 'Can a new user understand the first screen and complete the flow without help? Labels, errors, hidden assumptions.',
    cq: ['Is the confusion observable on the rendered page, or only inferred from code?', 'Which exact label/copy/state causes it, and what would a newcomer see instead?', 'Does an existing visible cue (label, helper text, error) already resolve it?'] },
  { key: 'ux-flow', ui: true, label: 'UX Flow Critic', lens: 'Beginning/middle/end of the journey, feedback on every action, confirm destructive actions, loading/success/recovery states.',
    cq: ['Which step lacks feedback, and what does the user actually see at that moment?', 'Is the missing state reachable in the real flow, not hypothetical?', 'Does an existing screen or test already provide that state?'] },
  { key: 'designer', ui: true, label: 'Designer Critic', lens: 'Layout hierarchy, spacing, alignment, typography, color, button/empty/loading/error states, mobile responsiveness.',
    cq: ['Which concrete element/property is off (selector, CSS value)?', 'Is it a violation of a stated rule (spacing/type scale, contrast) or taste?', 'Is it visible at the default viewport?'] },
  { key: 'artistic-direction', ui: true, label: 'Artistic Direction Critic', lens: 'Mood, visual identity, beauty, coherence — is it intentional and memorable or generic?',
    cq: ['What specifically reads as generic, and against which stated intent?', 'Is this inside the task scope or a redesign?', 'Would fixing it change anything a user notices?'] },
  { key: 'frontend-arch', ui: false, label: 'Frontend Architecture Critic', lens: 'Component boundaries, state, hooks, server/client split, TypeScript correctness, SOLID/DRY/KISS, no duplicated logic.',
    cq: ['Which file:line shows the boundary/state/typing problem?', 'Does it violate a stated rule (SOLID/DRY/KISS, CLAUDE.md) or only a preference?', 'What concrete failure or maintenance cost follows from it?'] },
  { key: 'qa-e2e', ui: false, label: 'QA / E2E Critic', lens: 'Critical paths, missing Playwright tests, meaningful vs superficial assertions, edge cases, did we actually verify localhost?',
    cq: ['Which user path is uncovered — which spec would cover it, and does it really not?', 'Is the existing assertion actually superficial (quote it)?', 'Would the proposed test fail on the bug it targets?'] },
  { key: 'accessibility', ui: true, label: 'Accessibility Critic', lens: 'Keyboard nav, focus states, accessible names, labels, form-error linkage, contrast, semantic HTML, dialog a11y. Judge against the CONCRETE bar in .claude/memory/topics/quality-bar.md (WCAG 2.1 AA: 4.5:1 / 3:1 contrast; zero serious/critical axe violations on the main flow), not vague "is it accessible" — cite the specific target a finding violates. Confirm pass/fail against an ACTUAL axe run (`pnpm test:e2e e2e/a11y.spec.ts`, or a result already in priorEvidence); never assert a11y status from memory.',
    cq: ['Which WCAG / quality-bar target is violated (cite it)?', 'Is there an axe result or keyboard run that shows it, or only code reading?', 'Does a visible label or ARIA attribute elsewhere already satisfy it?'] },
  { key: 'performance', ui: false, label: 'Performance Critic', lens: 'Unnecessary re-renders, large client bundles, heavy images, blocking fetches, overuse of client components. Judge against the CONCRETE bar in .claude/memory/topics/quality-bar.md (first-load client JS ≤ the documented gzipped budget), not vague "is it fast" — cite the measured number vs the budget. Obtain that number by running `pnpm build && pnpm check:bundle` (or reuse a bundle figure already in priorEvidence); never estimate or restate the quality-bar.md baseline as if it were a fresh measurement.',
    cq: ['What is the measured number vs the budget (pnpm check:bundle)?', 'Is the claimed cost on the first-load path?', 'Without a measurement, is this only a causal guess?'] },
  { key: 'security', ui: false, label: 'Security Critic', lens: 'Unsafe input handling, secrets exposed to the client, auth-bypass risk, missing server-side validation, unsafe redirects, XSS, insecure storage.',
    cq: ['Which input reaches which sink (trace file:line to file:line)?', 'Is that input attacker-controlled in practice?', 'Is there existing escaping/validation on the path?'] },
  { key: 'regression', ui: false, label: 'Regression Critic', lens: 'Existing routes/flows affected, shared components/APIs changed, snapshots, styling side effects, backward compatibility.',
    cq: ['Which caller/route depends on the changed code (file:line)?', 'Does the diff actually change that path\'s behavior?', 'Which existing test would catch the regression, and does it pass?'] },
]
// </critic-roster>
const CRITICS = ALL_CRITICS.filter((c) => uiInScope || !c.ui)
// Review mode. TRACE-Bench-lite measured it (F1, record TR-34201765532f; qualified:
// one 19-fixture run, 5 of 10 critics, diff-level block/no-block with the bench's own
// single-pass prompt): on CODE-ONLY review one all-lens reviewer matched the critic panel's
// recall and false-block rate at ~5x lower cost. So a round with no browser-facing critic in scope (uiInScope: false) uses
// ONE reviewer covering every in-scope lens by default; rounds that drive the app keep the
// panel (that case was not measured). Either way each finding names its lens and still goes
// to its own separate skeptic. Override with args.reviewMode: 'panel' | 'single-pass'.
const reviewMode = (a && ['panel', 'single-pass'].includes(a.reviewMode) && a.reviewMode) || (uiInScope ? 'panel' : 'single-pass')
if (a && a.reviewMode !== undefined && a.reviewMode !== reviewMode) log(`ignored args.reviewMode=${JSON.stringify(a.reviewMode)} (expected 'panel' or 'single-pass') — using ${reviewMode}`)
if (reviewMode === 'single-pass' && uiInScope) log('WARNING: single-pass forced with browser-facing lenses in scope — that combination was not measured')

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
        required: ['severity', 'claimType', 'title', 'evidence', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'important', 'nice-to-have'] },
          claimType: { type: 'string', enum: CRITIC_CLAIM_TYPES },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'Concrete observation: file:line, command output, or browser observation.' },
          recommendation: { type: 'string' },
          revisits: { type: 'string', description: 'record_id of a prior adjudicated claim this finding re-raises (from the prior-records list), if any' },
          revisitReason: { type: 'string', enum: ['still-present', 'new-evidence'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'claimType', 'evidenceChecked', 'counterReasons', 'failedGates', 'missing', 'repair', 'qualifier', 'reason'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS, description: 'accept = holds as stated; qualify = holds only at a weaker strength; revise = does not hold as stated (give repair); defer = cannot be settled with available evidence (name missing); reject = refuted' },
    claimType: { type: 'string', enum: CRITIC_CLAIM_TYPES, description: 'the claim type after your review (re-type it if the critic mistyped it)' },
    evidenceChecked: {
      type: 'array',
      description: 'the evidence YOU actually checked — kind + ref (+ result). Only cite what you verified.',
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'ref'],
        properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
      },
    },
    counterReasons: { type: 'array', items: { type: 'string' }, description: 'the refutation attempts / critical questions you put to the claim and how each came out' },
    failedGates: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' }, description: 'for defer: the evidence that would settle it' },
    repair: { type: 'string', description: 'for revise: the restated claim or bounded fix; else empty' },
    qualifier: { type: 'string', description: 'for qualify: the weaker strength the claim holds at; else empty' },
    reason: { type: 'string' },
  },
}

// Newest first: once the store grows, critics must still see the most recent verdicts.
const priorDigest = priorRecords.length
  ? [...priorRecords]
      .sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')))
      .slice(0, 40)
      .map((r) => `- ${r.record_id} [${r.final_status}] (${r.claim_type}) ${r.claim_text}${r.missing && r.missing.length ? ` — missing: ${r.missing.join('; ')}` : ''}`)
      .join('\n')
  : ''

// Phase 1 — every critic reviews independently and in parallel (a barrier: we want
// the full set before deduping and verifying).
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'

phase('Review')
// Shared prompt parts (identical for both modes).
const readOnlyBrief = `This is a READ-ONLY review: do not create, edit or delete any file in the repo (scratch copies outside it are fine). Read CLAUDE.md and the relevant memory topic page(s), inspect ${focus} (read the code; if a localhost flow is in scope, drive it via Playwright/Chrome MCP and check console + network)`
const reviewTail = `${priorEvidence ? `\nEvidence already gathered by the Lead — verify against it instead of re-deriving from scratch:\n${typeof priorEvidence === 'string' ? priorEvidence : JSON.stringify(priorEvidence)}\n` : ''}\nType every finding with a claimType and never state it stronger than your evidence — a separate skeptic holds each type to this standard:\n${claimTypeGuide}\n${priorDigest ? `\nThese claims were already adjudicated (TRACE records). Do NOT re-raise a rejected claim unless you bring NEW evidence. If a finding of yours matches one of them, set revisits to its record_id and revisitReason to "still-present" (the same issue persists, nothing new) or "new-evidence" (put the new evidence first):\n${priorDigest}\n` : ''}\nReturn only findings you can back with concrete evidence. An empty list is a valid, honest answer.`
const ITEM = FINDINGS_SCHEMA.properties.findings.items
const SINGLE_FINDINGS_SCHEMA = {
  ...FINDINGS_SCHEMA,
  properties: {
    findings: {
      ...FINDINGS_SCHEMA.properties.findings,
      items: { ...ITEM, required: [...ITEM.required, 'lens'], properties: { ...ITEM.properties, lens: { type: 'string', enum: CRITICS.map((c) => c.key), description: 'the key of the lens this finding belongs to' } } },
    },
  },
}
const withoutLens = (f) => {
  const g = { ...f }
  delete g.lens
  return g
}
// In single-pass mode the reviewer picks each finding's lens, and the priors digest does
// not show one. A finding that re-raises a prior claim takes that claim's lens when it is
// otherwise the same claim (same title slug and claim type) — so verdict reuse and
// `revises` keep working exactly as in panel mode, whatever lens the reviewer chose.
const lensOf = (f) => {
  const prior = f.revisits ? priorById.get(f.revisits) : null
  const m = prior && /^critic:([^:]+):(.+)$/.exec(String(prior.claim_id || ''))
  if (m && m[2] === slug(f.title) && prior.claim_type === f.claimType && CRITICS.some((c) => c.key === m[1])) return m[1]
  return f.lens
}
let unassignedFindings = 0
const reviews = reviewMode === 'single-pass'
  ? await agent(
      `You are the reviewer for this project, covering EVERY lens below in a single pass. ${readOnlyBrief}, then review through each lens in turn and tag every finding with the key of the lens it belongs to:\n${CRITICS.map((c) => `- ${c.key} (${c.label}): ${c.lens}`).join('\n')}\n${reviewTail}`,
      { label: 'critic:all-lenses-0', phase: 'Review', schema: SINGLE_FINDINGS_SCHEMA, model: FANOUT_MODEL },
    )
      .catch(() => null) // like parallel(): a throwing reviewer is a failed reviewer, not a crashed round
      .then((r) => {
        const found = r ? (r.findings || []).map((f) => ({ ...f, lens: lensOf(f) })) : []
        const unassigned = found.filter((f) => !CRITICS.some((c) => c.key === f.lens))
        unassignedFindings = unassigned.length
        if (unassigned.length) log(`WARNING: ${unassigned.length} finding(s) named no in-scope lens and were dropped: ${unassigned.map((f) => JSON.stringify(f.title)).join(', ')}`)
        // A reviewer that died leaves EVERY lens unreviewed — reported per lens below.
        return CRITICS.map((c) => ({ critic: c.key, label: c.label, findings: found.filter((f) => f.lens === c.key).map(withoutLens), failed: !r }))
      })
  : await parallel(
      CRITICS.map((c, i) => () =>
        agent(
          `You are the **${c.label}** for this project. ${readOnlyBrief}, then review strictly through your lens:\n${c.lens}\n${reviewTail}`,
          { label: `critic:${c.key}-${i}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: FANOUT_MODEL },
        ).then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [], failed: !r })),
      ),
    )
// A critic that died returned nothing — that is NOT "no findings". Surface it so a round
// with a silent lens is never mistaken for a clean pass.
const failedReviewers = reviews.filter((r) => !r || r.failed).map((r, i) => (r ? r.critic : `critic-${i}`))
if (failedReviewers.length) log(`WARNING: ${failedReviewers.length} critic(s) returned no result: ${failedReviewers.join(', ')} — the round is incomplete`)

// Flatten, then dedup on (severity + exact normalized title). On a collision, MERGE
// rather than drop. Agreement is NOT a stronger signal by itself: every critic is the
// same model family, so their errors are correlated (TRACE Prop. 4: n_eff → 1 as ρ → 1).
// Only a critic that brings DIFFERENT evidence corroborates — that evidence is kept
// separately and handed to the skeptic as an extra ledger entry.
const all = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, critic: r.critic, criticLabel: r.label })))
const byKey = new Map()
const evidenceSeen = new Map()
for (const f of all) {
  const k = `${f.severity}::${norm(f.title)}`
  const existing = byKey.get(k)
  if (existing) {
    existing.alsoFlaggedBy.push({ critic: f.critic, evidence: f.evidence })
    const ev = norm(f.evidence)
    // Corroboration needs a SEPARATE agent: in single-pass mode one reviewer filing the same
    // claim under two lenses is not independent evidence.
    if (reviewMode === 'panel' && ev && !evidenceSeen.get(k).has(ev)) {
      evidenceSeen.get(k).add(ev)
      existing.independentEvidence.push({ critic: f.critic, evidence: f.evidence })
    }
  } else {
    byKey.set(k, { ...f, alsoFlaggedBy: [], independentEvidence: [] })
    evidenceSeen.set(k, new Set([norm(f.evidence)]))
  }
}
const deduped = [...byKey.values()]
log(`${deduped.length} findings from ${CRITICS.length} lenses, ${reviewMode} (${all.length} before merge-dedup)`)

const criticByKey = new Map(ALL_CRITICS.map((c) => [c.key, c]))
const sameTree = (t) => !!(treeId && t && t === treeId)
const ownClaimId = (f) => `critic:${f.critic}:${slug(f.title)}`
// A critic's `revisits` link is an LLM assertion, never trusted on its own: it binds only
// when the prior record is deterministically the SAME claim (same lens, same normalized
// title, same claim type). Otherwise the link is dropped entirely — no reuse, no
// inherited claim_id, no `revises` — and the finding is adjudicated as a new claim.
const linkedPrior = (f) => {
  const prior = f.revisits ? priorById.get(f.revisits) : null
  return prior && prior.claim_id === ownClaimId(f) && prior.claim_type === f.claimType ? prior : null
}

// Phase 2 — adjudicate each blocker/important finding with a SEPARATE skeptic (the
// reviewer never confirms its own finding), unless it revisits a prior record as
// "still-present" on an identical working tree (verdict reuse). Nice-to-haves are recorded
// as-is, not adjudicated.
phase('Verify')
const toVerify = deduped.filter((f) => f.severity === 'blocker' || f.severity === 'important')
const settledAll = await parallel(
  toVerify.map((f, i) => () => {
    const prior = linkedPrior(f)
    if (f.revisits && !prior) log(`dropped unverifiable revisits link ${f.revisits} on "${f.title}" (not the same claim)`)
    // Only licensing verdicts are reused: a defer may be resolvable by evidence gathered
    // outside the tree, and a reject must not silently bury a re-raised blocker.
    if (prior && f.revisitReason === 'still-present' && ['accept', 'qualify'].includes(prior.final_status) && sameTree(prior.provenance && prior.provenance.tree)) {
      return Promise.resolve({
        ...f,
        verdict: prior.final_status,
        claimType: prior.claim_type,
        qualifier: prior.qualifier || '',
        missing: prior.missing || [],
        repair: prior.repair || '',
        failedGates: prior.failed_gates || [],
        evidenceChecked: [],
        counterReasons: [],
        preGateVerdict: prior.final_status,
        verifyReason: `reused ${prior.record_id}: same claim, identical tree ${treeId}`,
        reused: prior.record_id,
      })
    }
    const c = criticByKey.get(f.critic)
    const t = EVIDENCE_POLICY[f.claimType] ? f.claimType : 'factual'
    return agent(
      `Adversarially adjudicate this ${f.severity} finding from the ${f.criticLabel}. Try to REFUTE it by inspecting the actual code/flow, then return a TYPED verdict:\n- accept: holds as stated, and you verified evidence of the kind its claim type needs\n- qualify: holds, but only at a weaker strength (say which in qualifier)\n- revise: does not hold as stated, but a restated claim or bounded fix does (put it in repair)\n- defer: cannot be settled with the evidence available (name exactly what is missing)\n- reject: refuted\nDefault to defer when you cannot check the evidence, and to reject when the evidence does not hold up — never accept on the critic's word.\n\nClaim type: ${t} — ${CLAIM_TYPE_DEFS[t] || ''}. An accept needs evidence of kind ${EVIDENCE_POLICY[t].acceptNeeds.join('/')} that YOU checked; otherwise it is capped at ${EVIDENCE_POLICY[t].onFail}. Re-type the claim if the critic mistyped it.\n\nCritical questions for this lens (answer each in counterReasons):\n${(c && c.cq ? c.cq : ['Does the cited evidence actually show the claim?']).map((q) => `- ${q}`).join('\n')}\n${f.independentEvidence.length ? `\nIndependent evidence from other critics (different evidence, not mere agreement):\n${f.independentEvidence.map((e) => `- ${e.critic}: ${e.evidence}`).join('\n')}\n` : ''}${prior ? `\nThis claim revisits prior record ${prior.record_id} (verdict ${prior.final_status}${prior.missing && prior.missing.length ? `, missing: ${prior.missing.join('; ')}` : ''}; reason: ${prior.reason}). Decide whether the evidence now changes that verdict; if nothing material changed, return the prior verdict.\n` : ''}\nTitle: ${f.title}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
      { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
    ).then((v) => {
      // Fail safe: a missing/failed verdict becomes defer (never confirmed, never
      // "refuted" — an unreadable verdict is evidence of nothing). The deterministic
      // evidence gate then caps any licensing verdict the cited evidence cannot carry —
      // under BOTH the critic's and the skeptic's claim type, so re-typing a claim can
      // never lower its bar.
      const g = applyEvidenceGateStrict(v || {}, [v && v.claimType, t])
      return {
        ...f,
        verdict: g.verdict,
        claimType: g.claimType,
        ...(v && v.claimType && v.claimType !== t ? { retypedFrom: t } : {}),
        qualifier: g.qualifier,
        missing: g.missing,
        repair: g.repair,
        failedGates: g.failedGates,
        evidenceChecked: g.evidenceChecked,
        counterReasons: (v && v.counterReasons) || [],
        preGateVerdict: (v && v.verdict) || null,
        verifyReason: (v && v.reason) || 'verifier returned no verdict — deferred, not confirmed',
        ...(prior ? { revises: prior.record_id } : {}),
      }
    })
  }),
)

const settled = settledAll.filter(Boolean).map((o) => ({ ...o, real: LICENSING.includes(o.verdict) }))
const confirmed = settled.filter((o) => LICENSING.includes(o.verdict)) // accept + qualify — the actionable matrix
const revised = settled.filter((o) => o.verdict === 'revise')
const deferred = settled.filter((o) => o.verdict === 'defer')
const refuted = settled.filter((o) => o.verdict === 'reject')
const niceToHaves = deduped.filter((f) => f.severity === 'nice-to-have')

// TRACE-lite record drafts for every NEWLY adjudicated finding (the Lead appends them
// with `pnpm trace write`); reused verdicts get a REUSE action instead of a new record.
const traceRecords = settled
  .filter((o) => !o.reused)
  .map((o, i) => {
    const prior = o.revises ? priorById.get(o.revises) : null
    return {
      writer_id: `critic-panel/verify:${o.critic}-${i}`,
      claim_id: prior ? prior.claim_id : ownClaimId(o),
      claim_text: String(o.title || 'untitled finding'),
      claim_type: o.claimType,
      ...(o.retypedFrom ? { retyped_from: o.retypedFrom } : {}),
      severity: o.severity,
      subject: String(focus).slice(0, 200),
      evidence: [
        ...o.evidenceChecked.map((e) => ({ kind: e.kind, ref: String(e.ref), ...(e.result ? { result: String(e.result) } : {}) })),
        ...(o.evidence ? [{ kind: 'reading', ref: `critic (${o.critic}): ${String(o.evidence).slice(0, 400)}` }] : []),
      ],
      counter_reasons: o.counterReasons,
      failed_gates: o.failedGates,
      missing: o.missing,
      repair: o.repair,
      qualifier: o.qualifier,
      final_status: o.verdict,
      reason: String(o.verifyReason || 'no reason given'),
      provenance: { workflow: 'critic-panel', ...(treeId ? { tree: treeId } : {}) },
      ...(prior ? { revises: prior.record_id } : {}),
    }
  })
const reuseActions = settled
  .filter((o) => o.reused)
  .map((o) => ({ record_id: o.reused, consumer: 'critic-panel', action: 'REUSE', note: `still present on identical tree ${treeId}` }))

return {
  focus,
  treeId,
  reviewMode, // 'panel' (one critic per lens) or 'single-pass' (one all-lens reviewer)
  failedReviewers, // critics that returned nothing — the round is incomplete if non-empty
  counts: {
    critics: CRITICS.length,
    reviewAgents: reviewMode === 'single-pass' ? 1 : CRITICS.length,
    unassignedFindings,
    failedReviewers: failedReviewers.length,
    confirmedBlockers: confirmed.filter((f) => f.severity === 'blocker').length,
    confirmedImportant: confirmed.filter((f) => f.severity === 'important').length,
    qualified: confirmed.filter((f) => f.verdict === 'qualify').length,
    deferred: deferred.length,
    revised: revised.length,
    niceToHave: niceToHaves.length,
    refuted: refuted.length,
    reused: reuseActions.length,
    gateDowngrades: settled.filter((o) => o.preGateVerdict && o.preGateVerdict !== o.verdict).length,
    independentlyCorroborated: settled.filter((o) => o.independentEvidence && o.independentEvidence.length).length,
  },
  confirmed, // accept + qualify — the actionable matrix (qualify carries its qualifier)
  deferred, // cannot be settled yet — each names its `missing` evidence; not actioned
  revised, // does not hold as stated — `repair` holds the restated claim/fix; not actioned as-is
  niceToHaves, // recorded only, not adjudicated
  refuted, // a skeptic refuted these
  traceRecords, // TRACE-lite record drafts → `pnpm trace write`
  reuseActions, // → `pnpm trace act --from`
}
