export const meta = {
  name: 'scan-docs',
  description:
    'Deterministic doc-scanner: for each user story (passed in), pipeline an evidence-gathering agent then a separate status-verifier agent. Returns evidence-based per-story status records plus TRACE-lite record drafts; the caller writes the docs/stories files.',
  phases: [
    { title: 'Evidence', detail: 'gather implementation + test evidence per story' },
    { title: 'Verify', detail: 'a separate agent confirms an evidence-based status (no overclaiming)' },
  ],
}

// Normalize args: object, plain string, or JSON-encoded string. Parse the JSON case
// so structured fields (stories, models) resolve instead of silently no-opping.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try { a = JSON.parse(s) } catch { /* no structured fields available */ }
  }
}

// args.stories: [{ id, title, source, acceptanceCriteria? }]
// The caller extracts the story list from the PRD/docs first, then runs this.
const stories = (a && a.stories) || []
if (!stories.length) {
  return { error: 'No stories provided. Extract stories from docs first, then pass args.stories = [{id,title,source}].', records: [] }
}

// This workflow only inspects the repo (code + tests). Statuses that require a
// human/MCP browser pass — "Browser verified" and "Done" — are intentionally OUT of
// scope: the caller raises a story to those after verifying it in a browser.
const REPO_STATUSES = [
  'Not started', 'Partially implemented', 'Implemented',
  'Unit tested', 'E2E tested', 'Blocked', 'Deprecated',
]

// Model tiering (graph-engineering): per-story evidence gathering on the fast tier,
// the strict status verifier (the gate) on the strong tier. Override via args.models.
const FANOUT_MODEL = (a && a.models && a.models.fanout) || 'sonnet'
const JUDGE_MODEL = (a && a.models && a.models.judge) || 'opus'

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['implementationFiles', 'unitTests', 'e2eTests', 'proposedStatus', 'notes'],
  properties: {
    implementationFiles: { type: 'array', items: { type: 'string' }, description: 'files that implement this story (empty if none found)' },
    unitTests: { type: 'string', enum: ['Missing', 'Partial', 'Present'] },
    e2eTests: { type: 'string', enum: ['Missing', 'Partial', 'Present'] },
    proposedStatus: { type: 'string', enum: REPO_STATUSES },
    notes: { type: 'string' },
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
  required: ['finalStatus', 'justification', 'missing', 'evidenceChecked'],
  properties: {
    evidenceChecked: {
      type: 'array',
      description: 'the evidence YOU actually checked — kind + ref (+ result). Only cite what you verified.',
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'ref'],
        properties: { kind: { type: 'string', enum: EVIDENCE_KINDS }, ref: { type: 'string' }, result: { type: 'string' } },
      },
    },

    finalStatus: { type: 'string', enum: REPO_STATUSES },
    justification: { type: 'string', description: 'why the evidence supports this status; downgrade if the proposed status overclaims' },
    missing: { type: 'array', items: { type: 'string' }, description: 'the concrete evidence that would raise this story to its next status (e.g. "an E2E spec covering AC3"); empty only if none applies' },
  },
}

// TRACE verdict on the evidence agent's claim "story X is at status <proposed>":
// same status → accept; verifier downgraded it → qualify (the claim holds only at the
// lower status); upgraded or a Blocked/Deprecated mismatch → revise; no verdict → defer.
const STATUS_RANK = { 'Not started': 0, 'Partially implemented': 1, 'Implemented': 2, 'Unit tested': 3, 'E2E tested': 4 }
function storyVerdict(proposed, final, hasVerdict) {
  if (!hasVerdict) return 'defer'
  if (final === proposed) return 'accept'
  if (STATUS_RANK[final] != null && STATUS_RANK[proposed] != null && STATUS_RANK[final] < STATUS_RANK[proposed]) return 'qualify'
  return 'revise'
}

// On a missing verifier verdict, fail CLOSED: cap the maker's self-proposed status
// at "Implemented" (strip unverified test claims) rather than accepting it as-is.
const UNVERIFIED_CAP = ['Not started', 'Partially implemented', 'Implemented', 'Blocked', 'Deprecated']
function conservativeStatus(proposed) {
  return UNVERIFIED_CAP.includes(proposed) ? proposed : 'Implemented'
}

phase('Evidence')
// Pipeline: each story flows through evidence → verify independently (no barrier).
const records = await pipeline(
  stories,
  (story, i) =>
    agent(
      `Gather IMPLEMENTATION and TEST evidence for this user story by searching the codebase and tests (do not write any files):\n${JSON.stringify(story)}\n\nReport which files implement it, whether unit and E2E tests cover it, and the most defensible status. "Not started" is correct when no implementation is found.`,
      { label: `evidence:${story.id || 'story'}-${i}`, phase: 'Evidence', schema: EVIDENCE_SCHEMA, model: FANOUT_MODEL },
    ),
  (evidence, story, i) => {
    // Guard the first-stage result like every sibling workflow does — a null/failed
    // evidence agent must not throw and abort the pipeline. With no maker report there is
    // nothing to verify: defer (status unchanged) instead of letting the checker "accept"
    // an empty report as "Not started".
    const ev = evidence || {}
    if (!evidence) {
      return {
        id: story.id, title: story.title, source: story.source,
        implementationFiles: [], unitTests: 'Missing', e2eTests: 'Missing',
        finalStatus: null, justification: 'evidence agent returned nothing — not adjudicated; keep the current status',
        notes: '', proposedStatus: null, verdict: 'defer',
        missing: ['an evidence report for this story (the evidence agent returned nothing)'],
        repair: '', qualifier: '', failedGates: ['no-evidence-report'], evidenceChecked: [],
      }
    }
    return agent(
      `You are a strict status verifier for story ${story.id} (${story.title}). Confirm a status that is justified by REPO evidence only (code + tests). From repo evidence you can confirm at most "E2E tested"; "Browser verified" and "Done" require a separate browser pass and are OUT of scope here — never assign them. Downgrade if the proposed status overclaims. In evidenceChecked cite what YOU opened or ran (kind "file_line" for an implementation/test file you read, "command" for a command you ran) — the evidence agent's file list is a claim, not evidence you checked.\n\nProposed: ${JSON.stringify(ev)}`,
      { label: `verify:${story.id || 'story'}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
    ).then((v) => {
      const derived = storyVerdict(ev.proposedStatus || 'Not started', v ? v.finalStatus : null, !!v)
      const g = applyEvidenceGate({
        verdict: derived,
        claimType: 'factual',
        evidenceChecked: (v && v.evidenceChecked) || [],
        missing: v && Array.isArray(v.missing) ? v.missing : [],
        repair: derived === 'revise' && v ? `status is "${v.finalStatus}"` : '',
        qualifier: derived === 'qualify' && v ? `holds only at "${v.finalStatus}"` : '',
      })
      return {
      id: story.id,
      title: story.title,
      source: story.source,
      implementationFiles: ev.implementationFiles || [],
      unitTests: ev.unitTests || 'Missing',
      e2eTests: ev.e2eTests || 'Missing',
      // Fail closed: no verdict, or a verdict its own evidence cannot carry ⇒ conservative
      // cap on the maker's self-proposed status.
      finalStatus: v && g.verdict !== 'defer' ? v.finalStatus : conservativeStatus(ev.proposedStatus || 'Not started'),
      justification: (v && v.justification) || 'verifier returned no verdict — capped to a conservative status; needs manual review',
      notes: ev.notes || '',
      proposedStatus: ev.proposedStatus || 'Not started',
      verdict: g.verdict,
      missing: g.missing,
      repair: g.repair,
      qualifier: g.qualifier,
      failedGates: g.failedGates,
      evidenceChecked: g.evidenceChecked,
    }
    })
  },
)

const settled = records.filter(Boolean)

// TRACE-lite record drafts — one per story status claim (the caller writes them with
// `pnpm trace write` and cites the record_id in the story file before changing a status;
// no durable state change without a record).
const traceRecords = settled.map((r, i) => {
  // The gate guarantees a defer names what is missing (incl. "a verdict" when none came).
  const missing = r.missing
  return {
    writer_id: `scan-docs/verify:${r.id || 'story'}-${i}`,
    claim_id: `story:${String(r.id || 'story').toLowerCase()}:status`,
    claim_text: `Story ${r.id} (${r.title}) is at status "${r.proposedStatus || 'unknown — no evidence report'}"`,
    claim_type: 'factual',
    subject: String(r.id || 'story'),
    // Evidence = what the status verifier checked; the evidence agent's report is the
    // maker's claim, kept only as `reading`.
    evidence: [
      ...r.evidenceChecked.map((e) => ({ kind: e.kind, ref: String(e.ref), ...(e.result ? { result: String(e.result) } : {}) })),
      { kind: 'reading', ref: 'scan-docs evidence agent (maker report)', result: `implementation files: ${r.implementationFiles.join(', ') || 'none'}; unit tests: ${r.unitTests}; e2e tests: ${r.e2eTests}` },
    ],
    failed_gates: [...r.failedGates, ...(r.verdict === 'qualify' ? ['status-overclaim'] : [])],
    missing,
    repair: r.repair,
    qualifier: r.qualifier,
    final_status: r.verdict,
    reason: String(r.justification || 'no justification given'),
    provenance: { workflow: 'scan-docs' },
  }
})

return { count: settled.length, records: settled, traceRecords }
