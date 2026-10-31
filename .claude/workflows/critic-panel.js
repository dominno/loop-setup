export const meta = {
  name: 'critic-panel',
  description:
    'Deterministic multi-agent critic round: fan out the critics as parallel subagents (each in its own context, each typing its claims; a code-only round uses one all-lens reviewer instead), adversarially adjudicate every blocker, and important findings up to a verifier cap (the rest are recorded as defers), each with a separate skeptic that returns a typed TRACE verdict (accept/qualify/revise/defer/reject) held to the claim type evidence standard, reuse unchanged prior verdicts, then return a synthesized matrix plus TRACE-lite record drafts.',
  phases: [
    { title: 'Review', detail: 'each critic reviews independently, in its own context, and types each claim (a code-only round: one all-lens reviewer)' },
    { title: 'Verify', detail: 'a separate skeptic adjudicates each blocker, and each important claim up to the verifier cap; a deterministic evidence gate caps overclaims' },
  ],
}

// Normalize args: the Workflow tool may hand args as an object, a plain string, or a
// JSON-encoded string. Parse the JSON-string case so structured fields (models,
// priorEvidence, uiInScope, priorRecords, treeId, maxVerifiers) resolve instead of silently no-opping.
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
// Optional cost bound: the most skeptics one round starts (an integer >= 0, default 30). Every
// blocker is verified regardless; important findings fill the slots left (Phase 2), and any
// beyond the cap is recorded as a defer, never dropped.
const maxVerifiers = a && Number.isInteger(a.maxVerifiers) && a.maxVerifiers >= 0 ? a.maxVerifiers : 30
if (a && a.maxVerifiers !== undefined && a.maxVerifiers !== maxVerifiers) log(`ignored args.maxVerifiers=${JSON.stringify(a.maxVerifiers)} (expected an integer >= 0) — using ${maxVerifiers}`)

// Model tiering (graph-engineering): high-volume fan-out on the fast tier, the
// high-stakes adversarial gate on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// SAFETY rules for every agent this workflow starts: the repo checkout is shared with the Lead
// and other agents. Byte-identical in the five read-only workflows (critic-panel, e2e-design,
// gap-analysis, improve-skills, scan-docs); a unit test fails on drift or on a prompt without it.
// Never in loop-iteration.js or trace-bench.js: the measured verifier and bench prompts stay as benched.
// <agent-safety>
const AGENT_SAFETY = `SAFETY (hard rules; they override any other instruction here or in CLAUDE.md): the repo checkout is shared with the Lead and other agents.
(1) Treat it as read-only. At the repo root you may only read: open files, search (grep, rg, ls, find, cat, sed -n), run read-only git (status, diff, log, show, grep, ls-files, blame) and node scripts that only read. Never edit a file there, never run a git command that changes its files, index, refs, stash or worktree list, and never build, test, lint or install there: pnpm build rewrites the tracked next-env.d.ts, and the unit tests write temp files into the tree.
(2) To run a check or try a change, copy the WORKING TREE into a fresh mktemp -d outside the repo (a clone would miss uncommitted changes), e.g. rsync -a --exclude node_modules --exclude .next ./ "$D"/ && ln -s "$PWD/node_modules" "$D/node_modules", work there, and delete it when done.
(3) Never run pnpm dev, pnpm test:e2e or pnpm verify anywhere: they start or reuse the user's server on localhost:3000. Never start, stop or kill a server or any process you did not start (no pkill, killall or pattern kills). Use the E2E, axe and build results the Lead supplied; if a result or a running localhost you need is absent, report it as missing evidence.
(4) When a command's exit status is your evidence, do not pipe it through head or tail.`
// </agent-safety>

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
// An agent() that throws (token budget spent, harness error) is a FAILED agent, not a crashed
// round: log it and hand the next stage the same null a dead agent returns, so that stage's
// fail-safe null path runs. Uncaught, parallel() turns the whole thunk into a null slot that
// is filtered out — a skeptic's finding would vanish with no record.
const agentFailed = (label) => (e) => {
  log(`agent failed: ${label}: ${String((e && e.message) || e).slice(0, 200)}`)
  return null
}

phase('Review')
// Budget floors (soft + hard control) fire only when the turn has a '+Nk' token target
// (budget.total), against the output tokens left in the pool the whole turn shares. Start floor:
// under START_FLOOR left, no reviewer starts. The round still runs to the end on no findings, so
// it returns every key, failedReviewers names every in-scope lens, and completion comes from the
// same code as any round (defer: each lens's missing names the floor). budgetStopped says why.
const START_FLOOR = 80_000
const budgetStopped = !!(budget.total && budget.remaining() < START_FLOOR)
const startStop = budgetStopped ? `token budget floor reached before Review (${Math.round(budget.remaining() / 1000)}k left < ${START_FLOOR / 1000}k)` : ''
if (budgetStopped) log(`${startStop} — no agent started; every lens is reported unreviewed`)
// Shared prompt parts (identical for both modes, so both carry the SAFETY block).
const readOnlyBrief = `This is a READ-ONLY review: do not create, edit or delete any file in the repo.\n\n${AGENT_SAFETY}\n\nRead CLAUDE.md and the relevant memory topic page(s), inspect ${focus} (read the code; if a localhost flow is in scope, drive it via Playwright/Chrome MCP and check console + network)`
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
let unassigned = [] // single-pass findings tagged with no in-scope lens: dropped, never adjudicated
const reviews = budgetStopped
  ? CRITICS.map((c) => ({ critic: c.key, label: c.label, findings: [], failed: true })) // the start floor: no reviewer ran
  : reviewMode === 'single-pass'
    ? await agent(
        `You are the reviewer for this project, covering EVERY lens below in a single pass. ${readOnlyBrief}, then review through each lens in turn and tag every finding with the key of the lens it belongs to:\n${CRITICS.map((c) => `- ${c.key} (${c.label}): ${c.lens}`).join('\n')}\n${reviewTail}`,
        { label: 'critic:all-lenses-0', phase: 'Review', schema: SINGLE_FINDINGS_SCHEMA, model: FANOUT_MODEL },
      )
        .catch(agentFailed('critic:all-lenses-0')) // a throwing reviewer is a failed reviewer, not a crashed round
        .then((r) => {
          const found = r ? (r.findings || []).map((f) => ({ ...f, lens: lensOf(f) })) : []
          unassigned = found.filter((f) => !CRITICS.some((c) => c.key === f.lens))
          if (unassigned.length) log(`WARNING: ${unassigned.length} finding(s) named no in-scope lens and were dropped: ${unassigned.map((f) => JSON.stringify(f.title)).join(', ')}`)
          // A reviewer that died leaves EVERY lens unreviewed — reported per lens below.
          return CRITICS.map((c) => ({ critic: c.key, label: c.label, findings: found.filter((f) => f.lens === c.key).map(withoutLens), failed: !r }))
        })
    : await parallel(
        CRITICS.map((c, i) => () =>
          agent(
            `You are the **${c.label}** for this project. ${readOnlyBrief}, then review strictly through your lens:\n${c.lens}\n${reviewTail}`,
            { label: `critic:${c.key}-${i}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: FANOUT_MODEL },
          )
            .catch(agentFailed(`critic:${c.key}-${i}`))
            .then((r) => ({ critic: c.key, label: c.label, findings: (r && r.findings) || [], failed: !r })),
        ),
      )
// A critic that died returned nothing — that is NOT "no findings". Surface it so a round
// with a silent lens is never mistaken for a clean pass. `reviews` is index-aligned with
// CRITICS in both modes (a dead parallel() thunk is a null slot), so each is named by its key.
const failedReviewers = reviews.map((r, i) => (!r || r.failed ? CRITICS[i].key : null)).filter(Boolean)
if (failedReviewers.length && !budgetStopped) log(`WARNING: ${failedReviewers.length} critic(s) returned no result: ${failedReviewers.join(', ')} — the round is incomplete`)
// Every in-scope lens failed (or, below the start floor, none started): nothing was reviewed, so
// the round is an error, not an empty pass. The rest of the round still runs on no findings, so
// every key stays (empty) and a caller that only reads failedReviewers or completion fails closed too.
const error = budgetStopped
  ? `${startStop} — no review happened; re-run with a larger budget`
  : failedReviewers.length === CRITICS.length ? `all ${CRITICS.length} lens(es) failed (infra) — no review happened; re-run` : null
if (error) log(`ERROR: ${error}`)

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

// Phase 2 — adjudicate each blocker, and each important finding up to the verifier cap, with a
// SEPARATE skeptic (the reviewer never confirms its own finding), unless it revisits a prior
// record as "still-present" on an identical working tree (verdict reuse). Nice-to-haves are
// recorded as-is, not adjudicated.
phase('Verify')
const toVerify = deduped.filter((f) => f.severity === 'blocker' || f.severity === 'important')
const priors = toVerify.map(linkedPrior) // index-aligned with toVerify
// Only licensing verdicts are reused: a defer may be resolvable by evidence gathered
// outside the tree, and a reject must not silently bury a re-raised blocker.
const reusable = (f, prior) => !!(prior && f.revisitReason === 'still-present' && ['accept', 'qualify'].includes(prior.final_status) && sameTree(prior.provenance && prior.provenance.tree))

// Cost bounds. A reused verdict starts no agent, so it takes no slot. Every fresh blocker gets its
// skeptic; important findings fill the slots left under maxVerifiers, one per lens in turn (roster
// order), so review order never starves a lens. Below the verify floor no skeptic starts at all.
// A finding left out is an explicit defer (failedGates not-verified:*), never dropped; a defer is
// never reused, so the next round verifies it.
const VERIFY_FLOOR = 60_000
const fresh = toVerify.map((f, i) => i).filter((i) => !reusable(toVerify[i], priors[i]))
const freshBlockers = fresh.filter((i) => toVerify[i].severity === 'blocker').length
const roundRobin = (queues, slots) => {
  const out = []
  for (let r = 0; out.length < slots && queues.some((q) => r < q.length); r += 1) {
    for (const q of queues) if (r < q.length && out.length < slots) out.push(q[r])
  }
  return out
}
const granted = new Set(roundRobin(
  ALL_CRITICS.map((c) => fresh.filter((i) => toVerify[i].severity === 'important' && toVerify[i].critic === c.key)),
  Math.max(0, maxVerifiers - freshBlockers),
))
const overCap = fresh.filter((i) => toVerify[i].severity === 'important' && !granted.has(i))
const verifyStop = fresh.length && budget.total && budget.remaining() < VERIFY_FLOOR
  ? `token budget floor reached before Verify (${Math.round(budget.remaining() / 1000)}k left < ${VERIFY_FLOOR / 1000}k)`
  : ''
const notVerified = new Map() // toVerify index → why no skeptic adjudicates it
if (verifyStop) {
  for (const i of fresh) notVerified.set(i, { gate: 'not-verified:budget', why: verifyStop, next: 're-run the round with a larger budget' })
  log(`${verifyStop} — no skeptic started; ${fresh.length} blocker/important finding(s) deferred (not-verified:budget)`)
} else {
  for (const i of overCap) notVerified.set(i, { gate: 'not-verified:verifier-cap', why: `verifier cap ${maxVerifiers} reached`, next: 're-run focused on this finding or raise args.maxVerifiers' })
  if (toVerify.length) log(`Verify: ${toVerify.length - fresh.length} reused, ${fresh.length - overCap.length} skeptic(s): every blocker (${freshBlockers}) and ${granted.size} important finding(s) under maxVerifiers ${maxVerifiers}; ${overCap.length} cap-deferred`)
}

const settledAll = await parallel(
  toVerify.map((f, i) => () => {
    const prior = priors[i]
    if (f.revisits && !prior) log(`dropped unverifiable revisits link ${f.revisits} on "${f.title}" (not the same claim)`)
    if (reusable(f, prior)) {
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
    const skip = notVerified.get(i)
    if (skip) {
      // Over the cap, or below the verify floor: a defer with no agent. Unverified is evidence of
      // nothing (never confirmed, never refuted); the missing says how to get it verified.
      return Promise.resolve({
        ...f,
        verdict: 'defer',
        claimType: t,
        qualifier: '',
        missing: [`adversarial verification — skipped: ${skip.why}; ${skip.next}`],
        repair: '',
        failedGates: [skip.gate],
        evidenceChecked: [],
        counterReasons: [],
        preGateVerdict: null,
        verifyReason: `not adjudicated: no skeptic ran (${skip.why}) — deferred, never confirmed or refuted`,
        ...(prior ? { revises: prior.record_id } : {}),
      })
    }
    return agent(
      `Adversarially adjudicate this ${f.severity} finding from the ${f.criticLabel}. Try to REFUTE it by inspecting the actual code/flow, then return a TYPED verdict:\n- accept: holds as stated, and you verified evidence of the kind its claim type needs\n- qualify: holds, but only at a weaker strength (say which in qualifier)\n- revise: does not hold as stated, but a restated claim or bounded fix does (put it in repair)\n- defer: cannot be settled with the evidence available (name exactly what is missing)\n- reject: refuted\nDefault to defer when you cannot check the evidence, and to reject when the evidence does not hold up — never accept on the critic's word.\n\n${AGENT_SAFETY}\n\nClaim type: ${t} — ${CLAIM_TYPE_DEFS[t] || ''}. An accept needs evidence of kind ${EVIDENCE_POLICY[t].acceptNeeds.join('/')} that YOU checked; otherwise it is capped at ${EVIDENCE_POLICY[t].onFail}. Re-type the claim if the critic mistyped it.\n\nCritical questions for this lens (answer each in counterReasons):\n${(c && c.cq ? c.cq : ['Does the cited evidence actually show the claim?']).map((q) => `- ${q}`).join('\n')}\n${f.independentEvidence.length ? `\nIndependent evidence from other critics (different evidence, not mere agreement):\n${f.independentEvidence.map((e) => `- ${e.critic}: ${e.evidence}`).join('\n')}\n` : ''}${prior ? `\nThis claim revisits prior record ${prior.record_id} (verdict ${prior.final_status}${prior.missing && prior.missing.length ? `, missing: ${prior.missing.join('; ')}` : ''}; reason: ${prior.reason}). Decide whether the evidence now changes that verdict; if nothing material changed, return the prior verdict.\n` : ''}\nTitle: ${f.title}\nEvidence: ${f.evidence}\nRecommendation: ${f.recommendation}`,
      { label: `verify:${f.critic}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
    ).catch(agentFailed(`verify:${f.critic}:${i}`)).then((v) => {
      // Fail safe: a missing/failed verdict becomes defer (never confirmed, never
      // "refuted" — an unreadable verdict is evidence of nothing). The deterministic
      // evidence gate then caps any licensing verdict the cited evidence cannot carry —
      // under BOTH the critic's and the skeptic's claim type, so re-typing a claim can
      // never lower its bar. A dead skeptic (threw, or returned nothing) is also marked
      // 'agent-failed': an infra failure to re-run, not evidence anyone has to supply. Only
      // this code sets that gate: the gate copies a live skeptic's own failedGates, so an
      // 'agent-failed' among them is dropped (a live checker cannot forge the infra signal).
      const g = applyEvidenceGateStrict(v || {}, [v && v.claimType, t])
      return {
        ...f,
        verdict: g.verdict,
        claimType: g.claimType,
        ...(v && v.claimType && v.claimType !== t ? { retypedFrom: t } : {}),
        qualifier: g.qualifier,
        missing: g.missing,
        repair: g.repair,
        failedGates: v ? g.failedGates.filter((x) => x !== 'agent-failed') : [...g.failedGates, 'agent-failed'],
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

// Round integrity, computed here instead of inferred by the caller from empty lists. The
// claim "no open blocker" is refuted (reject) by a confirmed blocker. It cannot be settled
// (defer) while a lens failed (or none started: the start floor), a finding went unassigned, a
// blocker is deferred (by its skeptic, or with no skeptic below the verify floor) or revised,
// or an OPEN prior blocker sits in a lens this round did not review. Otherwise it holds.
// notRechecked = every prior record of an unreviewed lens (failed, out of scope, or an opt-in
// lens that is off): this round shows nothing about them, so it never clears one. Derived
// from the round's own results, so completion is not written as a record.
const reviewedLenses = new Set(CRITICS.map((c) => c.key).filter((k) => !failedReviewers.includes(k)))
const priorLens = (prior) => (/^critic:([^:]+):/.exec(String(prior.claim_id || '')) || [])[1] || null
const unreviewedPriors = priorRecords.filter((prior) => priorLens(prior) && !reviewedLenses.has(priorLens(prior)))
const newestOfClaim = new Map() // claim_id → newest created_at among the priors
for (const prior of priorRecords) {
  const at = String(prior.created_at || '')
  if (!newestOfClaim.has(prior.claim_id) || at > newestOfClaim.get(prior.claim_id)) newestOfClaim.set(prior.claim_id, at)
}
// Open = a blocker that no CLEAR names, not refuted, and not superseded by a newer prior.
const openPriorBlockers = unreviewedPriors.filter((prior) =>
  prior.severity === 'blocker' && !prior.cleared && ['accept', 'qualify', 'defer', 'revise'].includes(prior.final_status) &&
  String(prior.created_at || '') >= newestOfClaim.get(prior.claim_id))
const blockersIn = (list) => list.filter((f) => f.severity === 'blocker')
const completionMissing = [
  ...failedReviewers.map((k) => (budgetStopped ? `a review through the ${k} lens — not started: ${startStop}` : `a review through the ${k} lens — its reviewer failed (infra)`)),
  ...(unassigned.length ? [`an in-scope lens for ${unassigned.length} finding(s) the reviewer tagged with none — dropped, never adjudicated: ${unassigned.map((f) => JSON.stringify(String(f.title || 'untitled'))).join(', ')}`] : []),
  ...blockersIn(deferred).map((f) => `blocker "${f.title}" (${f.critic}) is deferred — missing: ${f.missing.join('; ')}`),
  ...blockersIn(revised).map((f) => `blocker "${f.title}" (${f.critic}) was revised — adjudicate the restated claim: ${f.repair}`),
  ...openPriorBlockers.map((prior) => `re-review of the ${priorLens(prior)} lens for open prior blocker ${prior.record_id} (or CLEAR it on verified evidence)`),
]
const completion = {
  claim: `no open blocker in: ${focus}`,
  verdict: blockersIn(confirmed).length ? 'reject' : completionMissing.length ? 'defer' : 'accept',
  missing: completionMissing,
  notRechecked: unreviewedPriors.map((prior) => prior.record_id),
}
log(`completion: ${completion.verdict} — ${completion.claim}${completion.missing.length ? ` (${completion.missing.length} missing)` : ''}`)

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
  ...(error ? { error } : {}), // every in-scope lens failed, or the start floor stopped the round: no review happened — re-run
  ...(budgetStopped ? { budgetStopped: true } : {}), // the start floor: no agent started; an incomplete round
  focus,
  treeId,
  reviewMode, // 'panel' (one critic per lens) or 'single-pass' (one all-lens reviewer)
  failedReviewers, // critics that returned nothing — the round is incomplete if non-empty
  completion, // { claim, verdict, missing, notRechecked } — the round is clean only when verdict is 'accept'
  counts: {
    critics: CRITICS.length,
    reviewAgents: budgetStopped ? 0 : reviewMode === 'single-pass' ? 1 : CRITICS.length, // review agents started
    unassignedFindings: unassigned.length,
    failedReviewers: failedReviewers.length,
    confirmedBlockers: confirmed.filter((f) => f.severity === 'blocker').length,
    confirmedImportant: confirmed.filter((f) => f.severity === 'important').length,
    qualified: confirmed.filter((f) => f.verdict === 'qualify').length,
    deferred: deferred.length,
    capDeferred: verifyStop ? 0 : overCap.length, // important findings over maxVerifiers: in `deferred`, never adjudicated
    revised: revised.length,
    niceToHave: niceToHaves.length,
    refuted: refuted.length,
    reused: reuseActions.length,
    gateDowngrades: settled.filter((o) => o.preGateVerdict && o.preGateVerdict !== o.verdict).length,
    independentlyCorroborated: settled.filter((o) => o.independentEvidence && o.independentEvidence.length).length,
  },
  confirmed, // accept + qualify — the actionable matrix (qualify carries its qualifier)
  deferred, // cannot be settled yet — each names its `missing` evidence; not actioned (incl. cap and budget defers: no skeptic ran)
  revised, // does not hold as stated — `repair` holds the restated claim/fix; not actioned as-is
  niceToHaves, // recorded only, not adjudicated
  refuted, // a skeptic refuted these
  traceRecords, // TRACE-lite record drafts → `pnpm trace write`
  reuseActions, // → `pnpm trace act --from`
}
