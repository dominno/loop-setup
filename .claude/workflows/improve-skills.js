export const meta = {
  name: 'improve-skills',
  description:
    "Deterministic meta-critic over the project's OWN prompts and orchestration: fan out one reviewer per quality lens across the command/workflow/instruction surface (.claude/commands/*.md, .claude/workflows/*.js, CLAUDE.md, skills-index, loop files), adversarially verify each blocker/important finding with a separate skeptic, and return PROPOSED edits. The caller applies them only on confirmation — this workflow never writes files.",
  phases: [
    { title: 'Review', detail: 'one meta-critic per lens reviews the prompt/workflow surface' },
    { title: 'Verify', detail: 'a separate skeptic refutes each finding AND its proposed edit' },
  ],
}

// Normalize args: a command may pass `args` as an object, a plain string, or a
// JSON-encoded string (e.g. '{"scope":"..."}'). Parse the JSON-string case so
// `a.scope`/`a.targets` resolve instead of leaking the raw JSON into `scope`.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* keep the string as a plain scope note */ }
  }
}

// Optional focus note + explicit target list, passed via the Workflow `args`.
const scope =
  (a && (a.scope || (typeof a === 'string' ? a : null))) ||
  'all custom prompts, skills, and workflow orchestration in this repo'
// The default prompt surface to review. Callers can pass args.targets to scope it.
const DEFAULT_TARGETS = [
  '.claude/commands/*.md',
  '.claude/workflows/*.js',
  'docs/workflow-graphs.md', // the Mermaid graphs — reviewed for drift vs the scripts
  'CLAUDE.md',
  '.claude/skills-index.md',
  '.claude/memory/index.md',
  '.claude/loop.md',
  '.claude/loop-checklist.md',
  '.claude/memory/loop-plan.md', // the plan/DAG contract (statuses + ready rule)
  '.claude/memory/topics/trace.md', // the TRACE-lite policy (verdicts, evidence gate, consumer matrix)
]
const targets = (a && Array.isArray(a.targets) && a.targets.length ? a.targets : DEFAULT_TARGETS)
const targetList = targets.join(', ')

// Model tiering (graph-engineering): the fan-out of meta-critics on the fast tier,
// the two-axis adversarial verifier on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// Meta-critic lenses — each reviews the SYSTEM'S OWN instructions, not product code.
// `code: true` lenses focus on the workflow .js orchestration; the rest on prose prompts.
const LENSES = [
  { key: 'clarity', code: false, label: 'Clarity & Actionability Critic', lens: 'Is every instruction unambiguous and written as an imperative the agent will actually follow? Flag vague/hedged steps, undefined terms, missing acceptance criteria, and steps with no checkable outcome.' },
  { key: 'instruction-following', code: false, label: 'Instruction-Following Risk Critic', lens: 'Where would an LLM plausibly misread, skip, or over-comply? Conflicting directives, a critical rule buried mid-paragraph, ambiguous ordering, "should" where "must" is meant, or prompts so long the key constraint is lost.' },
  { key: 'safety-gating', code: false, label: 'Safety & Gating Critic', lens: 'Are destructive or auto-applied actions properly confirmation-gated and denylist-aware? Flag any prompt that could auto-create/rewrite/delete files, commit/push, or self-modify core prompts WITHOUT an explicit confirmation gate. This is the most important lens for a self-improving system.' },
  { key: 'consistency-dry', code: false, label: 'Consistency & DRY Critic', lens: 'Contradictions or duplication ACROSS CLAUDE.md, the commands, skills-index.md, and the memory wiki. Flag facts/lists stated in multiple places that can drift apart (single-source-of-truth risk), and any command whose body contradicts CLAUDE.md or the wiki. Also: for each diagram in docs/workflow-graphs.md, verify its node list, model-tier annotations (🟢/🔵/⚪/▫️), and edges match the actual agent() calls (CRITICS/LENSES/DIMENSIONS/CATEGORIES arrays and FANOUT_MODEL/JUDGE_MODEL usage) in the corresponding .claude/workflows/*.js — flag any diagram that has drifted from its script.' },
  { key: 'workflow-dsl', code: true, label: 'Workflow DSL & Schema Critic', lens: 'For .claude/workflows/*.js only: fail-safe verifiers (a null/failed verdict must NOT confirm), unique agent labels that include the map index, guarded first pipeline stage before deref, fail-closed defaults, maker/checker given the REAL artifact (not a self-report), valid JSON Schemas, and a meta block that is a pure literal. Also check the graph-engineering conventions: correct FANOUT_MODEL/JUDGE_MODEL tiering (fan-out nodes on the fast tier; gates/judgment/synthesis on the strong tier; any code-writing node explicitly exempted rather than silently downgraded); and, where a budget guard exists, that it fails safe (skips or escalates on a floor breach and never auto-approves unverified work). For verdict-producing workflows also check the TRACE-lite contract (.claude/memory/topics/trace.md): typed verdicts (accept/qualify/revise/defer/reject), a null/failed verdict becomes defer (never confirmed, never counted as refuted), defer carries missing and revise carries repair, and the returned record drafts match what the workflow actually decided. Flag deviations.' },
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
const EVIDENCE_KINDS = ['file_line', 'command', 'browser', 'measurement', 'rule', 'diff', 'reading', 'record', 'human']

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'editSafe', 'saferEdit', 'missing', 'evidenceChecked', 'reason'],
  properties: {
    evidenceChecked: {
      type: 'array',
      description: 'the evidence YOU actually checked — kind + ref (+ result). Only cite what you verified.',
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'ref'],
        properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
      },
    },

    real: { type: 'boolean', description: 'true if the problem is genuine after trying to refute it' },
    editSafe: { type: 'boolean', description: 'true if the proposed edit is a real improvement that would NOT weaken instruction-following, safety gating, or break the workflow' },
    saferEdit: { type: 'string', description: 'when real but the proposed edit is NOT safe: a safer edit that would fix the problem without weakening anything; else empty' },
    missing: { type: 'array', items: { type: 'string' }, description: 'if you could not decide real/editSafe from the files: what is missing; else empty' },
    reason: { type: 'string' },
  },
}

// TRACE verdict derived deterministically from the two axes (the checker never picks
// "accept" directly): real+safe → accept (applyReady); real+unsafe edit → revise (the
// edit must be redesigned — saferEdit is the repair); not real → reject; no verdict or
// skipped verification → defer (unverified is evidence of nothing, never "refuted").
function traceVerdict(v) {
  if (!v) return 'defer'
  if (Array.isArray(v.missing) && v.missing.filter(Boolean).length && v.real !== false) return 'defer'
  if (v.real === false) return 'reject'
  return v.editSafe === true ? 'accept' : 'revise'
}

// Phase 1 — every meta-critic reviews the prompt surface independently, in parallel
// (a barrier: we want the full set before deduping and verifying).
phase('Review')
const reviews = await parallel(
  LENSES.map((c, i) => () =>
    agent(
      `You are the **${c.label}** auditing this project's OWN Claude Code configuration — its custom prompts, skills, and multi-agent orchestration. This is a READ-ONLY review: do not create, edit or delete any file in the repo. You are NOT reviewing product/application code; you are reviewing the instructions that drive the agent.\n\nRead these files (the prompt surface): ${targetList}\n${c.code ? 'Focus on the workflow orchestration scripts (.claude/workflows/*.js).' : 'Focus on the prose prompts (commands, CLAUDE.md, skills-index, loop files).'}\n\nReview strictly through your lens:\n${c.lens}\n\nScope: ${scope}\n\nFor each issue return concrete evidence (a quote or file:line) AND a specific proposedEdit (what to change to what). Propose improvements to the prompts/workflows themselves — do not propose product-code changes. An empty list is a valid, honest answer.`,
      { label: `meta:${c.key}-${i}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: FANOUT_MODEL },
    ).then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [], failed: !r })),
  ),
)
// A meta-critic that died is not "no findings" — surface it.
const failedReviewers = reviews.filter((r) => !r || r.failed).map((r, i) => (r ? r.critic : `lens-${i}`))
if (failedReviewers.length) log(`WARNING: ${failedReviewers.length} lens(es) returned no result: ${failedReviewers.join(', ')} — the pass is incomplete`)

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

// Budget as a HARD stop (soft + hard controls, graph-engineering): if the turn's token
// target is nearly spent, do NOT spawn the verifier fan-out. Findings become `deferred`
// (TRACE defer — missing: the adversarial verification), so nothing unverified is ever
// apply-ready or mistaken for a refutation.
const VERIFY_FLOOR = 60_000 // tokens to leave for the verify phase
const budgetStop = !!(budget.total && budget.remaining() < VERIFY_FLOOR)
let verified
if (budgetStop) {
  log(`budget floor reached (${Math.round(budget.remaining() / 1000)}k left) — skipping adversarial verify; ${toVerify.length} findings deferred (unverified, never auto-applied)`)
  verified = toVerify.map((f) => ({
    ...f,
    real: null, // unknown — not checked
    editSafe: false, // unverified ⇒ never apply-ready
    verdict: 'defer',
    missing: ['adversarial verification (skipped: token budget floor reached before the verify phase)'],
    repair: '',
    failedGates: ['not-verified'],
    evidenceChecked: [],
    verifyReason: 'unverified — token budget floor reached before the verify phase',
  }))
} else {
  verified = await parallel(
    toVerify.map((f, i) => () =>
      agent(
        `You are a SEPARATE skeptic (not the critic who raised this). Read the actual file and try to REFUTE this ${f.severity} finding about the project's own prompts/workflows.\n\nJudge two things independently:\n1. real — is the problem genuine? Default real:false if the evidence does not hold up.\n2. editSafe — would the proposed edit be a real improvement that does NOT weaken instruction-following, remove a safety/confirmation gate, or break a workflow? Default editSafe:false if you cannot confirm it is safe.\nIf the problem is real but the edit is not safe, propose a saferEdit. If you cannot decide from the files, list what is missing instead of guessing. In evidenceChecked cite what you actually checked: the file:line you read (kind "file_line") and the rule or standard you judged it against (kind "rule": a CLAUDE.md rule, a trace.md / loop.md policy line, or this lens's standard) — a finding accepted without a cited rule is deferred by the evidence gate.\n\nFile: ${f.file}\nTitle: ${f.title}\nEvidence: ${f.evidence}\nProposed edit: ${f.proposedEdit}`,
        { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
      ).then((v) => {
        // Fail safe: a missing/failed verdict must NOT confirm the finding or its edit —
        // and must not count as a refutation either: it is deferred.
        const derived = traceVerdict(v)
        // The two-axis verdict then faces the same evidence gate as every other checker
        // (normative claim: a licensing verdict needs a cited rule or a human decision).
        const g = applyEvidenceGate({
          verdict: derived,
          claimType: 'normative',
          evidenceChecked: (v && v.evidenceChecked) || [],
          missing: derived === 'defer'
            ? ((v && Array.isArray(v.missing) && v.missing.filter(Boolean).length) ? v.missing : ['a verdict from the verifier (none was returned)'])
            : [],
          repair: derived === 'revise' ? ((v && v.saferEdit) || 'design a safer edit — the proposed one could weaken a gate or break a workflow') : '',
        })
        return {
          ...f,
          real: v ? v.real : null,
          editSafe: v ? v.editSafe === true && g.verdict === 'accept' : false,
          verdict: g.verdict,
          preGateVerdict: derived,
          missing: g.missing,
          repair: g.repair,
          failedGates: g.failedGates,
          evidenceChecked: g.evidenceChecked,
          verifyReason: (v && v.reason) || 'verifier returned no verdict — deferred, not confirmed',
        }
      }),
    ),
  )
}

const niceToHaves = deduped.filter((f) => f.severity === 'nice-to-have')
const settled = verified.filter(Boolean)
// applyReady = accept (real problem + verified-safe edit) — the caller proposes these
// for confirmation. needsDesign = revise (real problem, edit not safe — `repair` is a
// safer edit to design from). deferred = could not be adjudicated. refuted = reject.
const applyReady = settled.filter((f) => f.verdict === 'accept')
const needsDesign = settled.filter((f) => f.verdict === 'revise')
const deferred = settled.filter((f) => f.verdict === 'defer')
const refuted = settled.filter((f) => f.verdict === 'reject')
const confirmed = [...applyReady, ...needsDesign]

// TRACE-lite record drafts — one per adjudicated finding. The caller writes them with
// `pnpm trace write`, then appends CLEAR (edit applied after confirmation) or REJECT
// (declined) as the consumer action.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'x'
const lensLabel = new Map(LENSES.map((l) => [l.key, l.label]))
const traceRecords = settled.map((f, i) => ({
  writer_id: `improve-skills/verify:${f.critic}-${i}`,
  claim_id: `improve:${f.critic}:${slug(f.file)}:${slug(f.title)}`,
  claim_text: `${f.title} — proposed edit: ${String(f.proposedEdit || '').slice(0, 300)}`,
  claim_type: 'normative',
  severity: f.severity,
  subject: String(f.file || '(cross-file)'),
  // Evidence = what the SEPARATE verifier checked; the meta-critic's own evidence is kept
  // only as `reading` (a maker's claim, never sufficient for a licensing verdict).
  evidence: [
    ...(f.evidenceChecked || []).map((e) => ({ kind: e.kind, ref: String(e.ref), ...(e.result ? { result: String(e.result) } : {}) })),
    ...(f.evidence ? [{ kind: 'reading', ref: `${lensLabel.get(f.critic) || f.critic}: ${String(f.evidence).slice(0, 400)}` }] : []),
  ],
  failed_gates: [...(f.failedGates || []), ...(f.preGateVerdict === 'revise' ? ['edit-safety'] : [])],
  missing: f.missing || [],
  repair: f.repair || '',
  final_status: f.verdict,
  reason: String(f.verifyReason || 'no reason given'),
  provenance: { workflow: 'improve-skills' },
}))

return {
  scope,
  targets,
  budgetStop, // true ⇒ verify was skipped for budget; every blocker/important finding is in `deferred`
  failedReviewers, // lenses that returned nothing — the pass is incomplete if non-empty
  counts: {
    lenses: LENSES.length,
    failedReviewers: failedReviewers.length,
    confirmedBlockers: confirmed.filter((f) => f.severity === 'blocker').length,
    confirmedImportant: confirmed.filter((f) => f.severity === 'important').length,
    applyReady: applyReady.length,
    needsDesign: needsDesign.length,
    deferred: deferred.length,
    niceToHave: niceToHaves.length,
    refuted: refuted.length,
  },
  applyReady, // accept: real problem + verified-safe edit → caller proposes these for confirmation
  needsDesign, // revise: real problem, edit not confirmed safe → `repair` holds a safer edit to design from
  deferred, // defer: not adjudicated (no verdict, or verification skipped) — UNVERIFIED, never applied
  niceToHaves, // recorded only, not verified
  refuted, // reject: a skeptic refuted these
  traceRecords, // TRACE-lite record drafts → `pnpm trace write`
}
