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

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['finalStatus', 'justification', 'missing'],
  properties: {
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
    // evidence agent must not throw and abort the pipeline.
    const ev = evidence || {}
    return agent(
      `You are a strict status verifier for story ${story.id} (${story.title}). Confirm a status that is justified by REPO evidence only (code + tests). From repo evidence you can confirm at most "E2E tested"; "Browser verified" and "Done" require a separate browser pass and are OUT of scope here — never assign them. Downgrade if the proposed status overclaims.\n\nProposed: ${JSON.stringify(ev)}`,
      { label: `verify:${story.id || 'story'}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: JUDGE_MODEL },
    ).then((v) => ({
      id: story.id,
      title: story.title,
      source: story.source,
      implementationFiles: ev.implementationFiles || [],
      unitTests: ev.unitTests || 'Missing',
      e2eTests: ev.e2eTests || 'Missing',
      // Fail closed: no verdict ⇒ conservative cap on the maker's self-proposed status.
      finalStatus: v ? v.finalStatus : conservativeStatus(ev.proposedStatus || 'Not started'),
      justification: (v && v.justification) || 'verifier returned no verdict — capped to a conservative status; needs manual review',
      notes: ev.notes || '',
      proposedStatus: ev.proposedStatus || 'Not started',
      verdict: storyVerdict(ev.proposedStatus || 'Not started', v ? v.finalStatus : null, !!v),
      missing: (v && Array.isArray(v.missing) ? v.missing.filter(Boolean) : []),
    }))
  },
)

const settled = records.filter(Boolean)

// TRACE-lite record drafts — one per story status claim (the caller writes them with
// `pnpm trace write` and cites the record_id in the story file before changing a status;
// no durable state change without a record).
const traceRecords = settled.map((r, i) => {
  const missing = r.verdict === 'defer'
    ? [...r.missing, 'a status-verifier verdict (none was returned — status capped conservatively)']
    : r.missing
  return {
    writer_id: `scan-docs/verify:${r.id || 'story'}-${i}`,
    claim_id: `story:${String(r.id || 'story').toLowerCase()}:status`,
    claim_text: `Story ${r.id} (${r.title}) is at status "${r.proposedStatus}"`,
    claim_type: 'factual',
    subject: String(r.id || 'story'),
    evidence: [
      ...r.implementationFiles.map((f) => ({ kind: 'file_line', ref: String(f) })),
      { kind: 'command', ref: 'repo code + test search (scan-docs evidence agent)', result: `implementation files: ${r.implementationFiles.length}; unit tests: ${r.unitTests}; e2e tests: ${r.e2eTests}` },
    ],
    failed_gates: r.verdict === 'qualify' ? ['status-overclaim'] : [],
    missing,
    repair: r.verdict === 'revise' ? `status is "${r.finalStatus}"` : '',
    qualifier: r.verdict === 'qualify' ? `holds only at "${r.finalStatus}"` : '',
    final_status: r.verdict,
    reason: String(r.justification || 'no justification given'),
    provenance: { workflow: 'scan-docs' },
  }
})

return { count: settled.length, records: settled, traceRecords }
