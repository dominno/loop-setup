export const meta = {
  name: 'scan-docs',
  description:
    'Deterministic doc-scanner: for each user story (passed in), pipeline an evidence-gathering agent then a separate status-verifier agent. Returns evidence-based per-story status records; the caller writes the docs/stories files.',
  phases: [
    { title: 'Evidence', detail: 'gather implementation + test evidence per story' },
    { title: 'Verify', detail: 'a separate agent confirms an evidence-based status (no overclaiming)' },
  ],
}

// args.stories: [{ id, title, source, acceptanceCriteria? }]
// The caller extracts the story list from the PRD/docs first, then runs this.
const stories = (args && args.stories) || []
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
  required: ['finalStatus', 'justification'],
  properties: {
    finalStatus: { type: 'string', enum: REPO_STATUSES },
    justification: { type: 'string', description: 'why the evidence supports this status; downgrade if the proposed status overclaims' },
  },
}

// Pipeline: each story flows through evidence → verify independently (no barrier).
const records = await pipeline(
  stories,
  (story) =>
    agent(
      `Gather IMPLEMENTATION and TEST evidence for this user story by searching the codebase and tests (do not write any files):\n${JSON.stringify(story)}\n\nReport which files implement it, whether unit and E2E tests cover it, and the most defensible status. "Not started" is correct when no implementation is found.`,
      { label: `evidence:${story.id}`, phase: 'Evidence', schema: EVIDENCE_SCHEMA },
    ),
  (evidence, story) =>
    agent(
      `You are a strict status verifier for story ${story.id} (${story.title}). Confirm a status that is justified by REPO evidence only (code + tests). From repo evidence you can confirm at most "E2E tested"; "Browser verified" and "Done" require a separate browser pass and are OUT of scope here — never assign them. Downgrade if the proposed status overclaims.\n\nProposed: ${JSON.stringify(evidence)}`,
      { label: `verify:${story.id}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({
      id: story.id,
      title: story.title,
      source: story.source,
      implementationFiles: evidence.implementationFiles,
      unitTests: evidence.unitTests,
      e2eTests: evidence.e2eTests,
      finalStatus: v ? v.finalStatus : evidence.proposedStatus,
      justification: (v && v.justification) || 'verifier returned no verdict — using gathered repo evidence',
      notes: evidence.notes,
    })),
)

return { count: records.filter(Boolean).length, records: records.filter(Boolean) }
