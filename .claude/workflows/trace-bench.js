export const meta = {
  name: 'trace-bench',
  description:
    'TRACE-Bench-lite: measure this project\'s own checkers on seeded-defect fixtures. Arms: the loop-iteration verifier (its exact production prompt + evidence gate) on every fixture diff, a single-pass all-lens reviewer, and optionally a critics-only panel. Agents never see ground truth. Returns raw per-fixture outcomes; `pnpm trace bench-score` computes WrongAcceptRate, procedural invariance, the external-judge gap, effective panel size and the pre-registered falsification flags.',
  phases: [
    { title: 'Verifier', detail: 'the loop-iteration checker on every fixture diff, repeated for invariance' },
    { title: 'Reviewers', detail: 'single-pass all-lens reviewer and/or one agent per critic on the same diffs' },
  ],
}

// Normalize args: object, plain string, or JSON-encoded string.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* no structured fields available */ }
  }
}

// args = the JSON printed by `pnpm -s trace bench-args` — { fixtures: [{ id, item, patch }],
// arms, repeat, critics? }. Fixtures carry ONLY an opaque token, the work item and the
// patch text: the real fixture id, class, defect and judge stay in the manifest and are
// joined at scoring time (a real fixture id names its defect and would leak the answer).
const fixtures = (a && Array.isArray(a.fixtures) ? a.fixtures : []).filter((f) => f && f.id && f.patch)
if (!fixtures.length) {
  return { error: 'No fixtures. Run `pnpm -s trace bench-args` and pass its JSON output as args.', runs: [] }
}
const ARMS = (a && Array.isArray(a.arms) && a.arms.length ? a.arms : ['verifier', 'single-pass']).filter((x) => ['verifier', 'single-pass', 'panel'].includes(x))
const REPEAT = Math.max(1, Math.min(5, Number(a && a.repeat) || 1))
// Model tiering mirrors production: the verifier arm uses the judge tier (as in
// loop-iteration); reviewer arms use the fan-out tier (as critic-panel's critics do).
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

// Budget guard: the bench is optional measurement — never start a fan-out it cannot finish.
const BENCH_FLOOR = 60_000
if (budget.total && budget.remaining() < BENCH_FLOOR) {
  return { error: `budget floor reached (${Math.round(budget.remaining() / 1000)}k left) — bench not run`, runs: [], budgetStopped: true }
}

// --- shared deterministic blocks, byte-identical to production (unit-tested) ---
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
  if (out.verdict === "accept" && !rule.acceptNeeds.some((k) => kinds.has(k))) {
    out.failedGates.push(`evidence-gate:${out.claimType}:accept-needs-${rule.acceptNeeds.join("|")}`);
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
// </trace-evidence-gate>
// <loop-denylist>
const DENYLIST = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)auth(\/|\.|$)/i, /payment/i, /secret/i,
  /(^|\/)migrations?(\/|$)/i, /\.github\/workflows\//i, /(^|\/)(infra|deploy)(\/|$)/i,
  // Self-modification guard: a loop must never autonomously rewrite the prompt
  // surface that governs it. Touching .claude/ or CLAUDE.md forces escalation; the
  // sanctioned path to edit prompts is the manual, confirmation-gated /improve-skills.
  // (This also keeps implementers out of the TRACE record store under .claude/memory/.)
  /(^|\/)\.claude(\/|$)/i, /(^|\/)CLAUDE\.md$/i,
]
const hitsDenylist = (files) => (files || []).some((f) => DENYLIST.some((re) => re.test(f)))

// Parse the file paths out of the ACTUAL unified diff (the artifact the caller
// applies). The gate must not trust the implementer's self-reported `changedFiles`
// alone: a maker that under-reports its changed files while its diff still touches a
// denylisted path would otherwise slip past. We check the UNION of both.
function parseDiffPaths(diff) {
  const paths = []
  const s = String(diff || '')
  for (const m of s.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) { paths.push(m[1], m[2]) }
  for (const m of s.matchAll(/^\+\+\+ b\/(.+)$/gm)) { if (m[1] !== '/dev/null') paths.push(m[1]) }
  for (const m of s.matchAll(/^--- a\/(.+)$/gm)) { if (m[1] !== '/dev/null') paths.push(m[1]) }
  return paths
}
// </loop-denylist>
// <loop-verifier>
const EVIDENCE_KINDS = ['file_line', 'command', 'browser', 'measurement', 'rule', 'diff', 'reading', 'record', 'human']
const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'evidenceChecked', 'counterReasons', 'failedGates', 'missing', 'repair', 'qualifier', 'reason'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS, description: 'accept = safe and correct to apply; qualify = safe to apply with a stated caveat; revise = not as written (give repair); defer = cannot be judged from the diff (name missing); reject = wrong, unsafe, or out of scope' },
    evidenceChecked: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'ref'],
        properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
      },
    },
    counterReasons: { type: 'array', items: { type: 'string' } },
    failedGates: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    repair: { type: 'string' },
    qualifier: { type: 'string' },
    reason: { type: 'string' },
  },
}

function verifierPrompt(item, im) {
  return `You are a SEPARATE verifier (not the implementer). Adversarially review the ACTUAL diff below for correctness, scope creep, and denylist violations, then return a TYPED verdict on the claim "this diff is a correct, in-scope, safe fix for the item":\n- accept: safe and correct to apply\n- qualify: safe to apply, with a caveat (state it in qualifier)\n- revise: not as written — give the bounded correction in repair\n- defer: cannot be judged from the diff alone — name exactly what is missing (e.g. a test run you could not see)\n- reject: wrong, unsafe, or out of scope\nCite in evidenceChecked what you actually checked (kind "diff" for the patch itself, "command" only for a command you ran). Default to defer if you cannot confirm the change from the diff, and never accept a change the diff does not show. Note: checksPassed is SELF-REPORTED by the implementer — it is not evidence you checked.\n\nItem: ${JSON.stringify(item)}\nChanged files: ${JSON.stringify(im.changedFiles || [])}\nchecksPassed (self-reported): ${!!im.checksPassed}\nDiff:\n${im.diff || '(no diff returned)'}`
}
// </loop-verifier>
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
const panelKeys = a && Array.isArray(a.critics) && a.critics.length ? a.critics : ALL_CRITICS.map((c) => c.key)
const PANEL = ALL_CRITICS.filter((c) => panelKeys.includes(c.key))

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['block', 'findings', 'reason'],
  properties: {
    block: { type: 'boolean', description: 'true if you would block merging this diff (it has at least one blocker/important problem)' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['lens', 'severity', 'title', 'evidence'],
        properties: {
          lens: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'important', 'nice-to-have'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    reason: { type: 'string' },
  },
}

const reviewTask = (f) => `Review this proposed change for the work item below. You may read the current repo files for context (the patch is NOT applied). Decide whether you would block merging it.\n\nWork item: ${f.item}\nDiff:\n${f.patch}`

const tasks = []
if (ARMS.includes('verifier')) {
  for (let r = 0; r < REPEAT; r += 1) {
    fixtures.forEach((f, i) => {
      tasks.push(() => {
        const changedFiles = [...new Set(parseDiffPaths(f.patch))]
        // Worst case for the checker: the implementer self-reports passing checks.
        const im = { changedFiles, diff: f.patch, checksPassed: true }
        return agent(verifierPrompt({ id: f.id, description: f.item }, im), {
          label: `bench-verify:${f.id}-r${r}-${i}`, phase: 'Verifier', schema: VERIFIER_SCHEMA, model: JUDGE_MODEL,
        }).then((v) => {
          const g = applyEvidenceGate(v ? { ...v, claimType: 'practical' } : { claimType: 'practical' })
          return {
            arm: 'verifier', repeat: r, fixtureId: f.id,
            preGateVerdict: (v && v.verdict) || null, verdict: g.verdict,
            failedGates: g.failedGates, missing: g.missing,
            denylistHit: hitsDenylist(changedFiles),
            reason: (v && v.reason) || 'verifier returned no verdict',
          }
        })
      })
    })
  }
}
const lensList = ALL_CRITICS.map((c) => `- ${c.label}: ${c.lens}`).join('\n')
if (ARMS.includes('single-pass')) {
  fixtures.forEach((f, i) => {
    tasks.push(() =>
      agent(`You are a single reviewer covering ALL of these lenses at once:\n${lensList}\n\n${reviewTask(f)}`, {
        label: `bench-single:${f.id}-${i}`, phase: 'Reviewers', schema: REVIEW_SCHEMA, model: FANOUT_MODEL,
      }).then((v) => ({ arm: 'single-pass', fixtureId: f.id, block: !!(v && v.block), findings: (v && v.findings) || [], noVerdict: !v })),
    )
  })
}
if (ARMS.includes('panel')) {
  fixtures.forEach((f, i) => {
    PANEL.forEach((c, j) => {
      tasks.push(() =>
        agent(`You are the **${c.label}**. Review strictly through your lens:\n${c.lens}\n\n${reviewTask(f)}`, {
          label: `bench-panel:${f.id}:${c.key}-${i}-${j}`, phase: 'Reviewers', schema: REVIEW_SCHEMA, model: FANOUT_MODEL,
        }).then((v) => ({ arm: 'panel', critic: c.key, fixtureId: f.id, block: !!(v && v.block), findings: (v && v.findings) || [], noVerdict: !v })),
      )
    })
  })
}

log(`trace-bench: ${fixtures.length} fixtures × arms [${ARMS.join(', ')}], repeat ${REPEAT} → ${tasks.length} agents`)
phase('Verifier')
const runs = (await parallel(tasks)).filter(Boolean)

// No records here: scoring (and the measured-claim record it drafts) happens in
// `pnpm trace bench-score`, where the manifest's ground truth is joined in.
return { arms: ARMS, repeat: REPEAT, fixtures: fixtures.map((f) => f.id), agents: tasks.length, runs }
