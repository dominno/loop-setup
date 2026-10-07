import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_ALLOWED,
  EVIDENCE_POLICY,
  VERDICTS,
  applyEvidenceGate,
  appendActions,
  effectivePanelSize,
  latestByClaim,
  loadEntries,
  loadSchema,
  meanPairwiseCorrelation,
  parseLines,
  pathFromRef,
  readPolicyVersion,
  reauditCandidates,
  replay,
  rotateStore,
  schemaKeywordViolations,
  scoreBench,
  semanticViolations,
  storeMetrics,
  treeFingerprint,
  validate,
  writeRecords,
} from "./lib.mjs";

const schema = loadSchema();
const POLICY = readPolicyVersion();
const NOW = "2026-10-07T12:00:00.000Z";
const COMMIT = "abc1234def56";

const draft = (over = {}) => ({
  writer_id: "test/verify:x-0",
  claim_id: "critic:qa-e2e:missing-test",
  claim_text: "The cleared-name path has no E2E test",
  claim_type: "factual",
  evidence: [{ kind: "file_line", ref: "e2e/remember-me.spec.ts:27" }],
  final_status: "accept",
  reason: "no spec exercises it",
  provenance: { workflow: "critic-panel" },
  ...over,
});

let dir;
let store;
const ctx = () => ({ storePath: store, now: NOW, policyVersion: POLICY, commit: COMMIT, schema });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-"));
  store = join(dir, "records.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("schema", () => {
  it("uses only keywords the mini-validator supports (no silent no-op keywords)", () => {
    expect(schemaKeywordViolations(schema)).toEqual([]);
  });

  it("rejects missing required fields, bad enums, unknown properties and bad patterns", () => {
    const errs = validate(schema.$defs.record, { kind: "record", claim_type: "vibes", extra: 1, record_id: "TR-nope" }, schema);
    expect(errs.some((e) => e.includes('missing required "claim_text"'))).toBe(true);
    expect(errs.some((e) => e.includes("claim_type: must be one of"))).toBe(true);
    expect(errs.some((e) => e.includes('unknown property "extra"'))).toBe(true);
    expect(errs.some((e) => e.includes("record_id: does not match"))).toBe(true);
  });

  it("claim_type enum matches the evidence policy (one source of truth)", () => {
    expect(schema.$defs.record.properties.claim_type.enum.sort()).toEqual(Object.keys(EVIDENCE_POLICY).sort());
    expect(schema.$defs.record.properties.final_status.enum).toEqual(VERDICTS);
    expect(schema.$defs.action.properties.action.enum.sort()).toEqual(Object.keys(ACTION_ALLOWED).sort());
  });
});

describe("evidence gate (rung discipline)", () => {
  it("downgrades an accept whose evidence is weaker than the claim type demands", () => {
    const g = applyEvidenceGate({ verdict: "accept", claimType: "measured", evidenceChecked: [{ kind: "reading", ref: "page.tsx" }] });
    expect(g.verdict).toBe("defer");
    expect(g.missing.join(" ")).toMatch(/measurement/);
    expect(g.failedGates[0]).toMatch(/^evidence-gate:measured/);
  });

  it("caps a causal claim backed only by reading at qualify, with a qualifier", () => {
    const g = applyEvidenceGate({ verdict: "accept", claimType: "causal", evidenceChecked: [{ kind: "reading", ref: "x" }] });
    expect(g.verdict).toBe("qualify");
    expect(g.qualifier).toMatch(/code reading only/);
  });

  it("keeps an accept that carries an accepted evidence kind", () => {
    const g = applyEvidenceGate({ verdict: "accept", claimType: "factual", evidenceChecked: [{ kind: "file_line", ref: "a.ts:1" }] });
    expect(g.verdict).toBe("accept");
    expect(g.failedGates).toEqual([]);
  });

  it("treats a missing or unknown verdict as defer — never accept, never reject", () => {
    expect(applyEvidenceGate(null).verdict).toBe("defer");
    expect(applyEvidenceGate({ verdict: "approve" }).verdict).toBe("defer");
    expect(applyEvidenceGate(null).missing.length).toBeGreaterThan(0);
  });

  it("forces defer to name what is missing and revise to carry a repair", () => {
    expect(applyEvidenceGate({ verdict: "defer", claimType: "factual" }).missing.length).toBe(1);
    expect(applyEvidenceGate({ verdict: "revise", claimType: "factual" }).repair).toMatch(/unspecified/);
  });

  it("a qualify with no evidence at all becomes defer", () => {
    expect(applyEvidenceGate({ verdict: "qualify", claimType: "predictive", evidenceChecked: [] }).verdict).toBe("defer");
  });
});

describe("semantic record rules", () => {
  it("flags accept without the claim type's evidence, defer without missing, revise without repair, qualify without qualifier", () => {
    expect(semanticViolations({ final_status: "accept", claim_type: "measured", evidence: [{ kind: "reading", ref: "x" }], missing: [] }).join()).toMatch(/evidence-gate/);
    expect(semanticViolations({ final_status: "defer", claim_type: "factual", evidence: [], missing: [] }).join()).toMatch(/missing/);
    expect(semanticViolations({ final_status: "revise", claim_type: "factual", evidence: [], missing: [] }).join()).toMatch(/repair/);
    expect(semanticViolations({ final_status: "qualify", claim_type: "causal", evidence: [{ kind: "reading", ref: "x" }], missing: [] }).join()).toMatch(/qualifier/);
  });
});

describe("write API (append-only, all-or-nothing)", () => {
  it("stamps writer-owned fields, validates, and appends", () => {
    const [res] = writeRecords([draft()], ctx());
    expect(res.validation).toBe("pass");
    expect(res.stored).toBe(true);
    const [line] = readFileSync(store, "utf8").trim().split("\n");
    const rec = JSON.parse(line);
    expect(rec).toMatchObject({ kind: "record", schema_version: "trace-lite/1.0", policy_version: String(POLICY), created_at: NOW });
    expect(rec.provenance.commit).toBe(COMMIT);
    expect(rec.record_id).toMatch(/^TR-[0-9a-f]{12}$/);
  });

  it("stores nothing when any record in the batch is invalid", () => {
    const res = writeRecords([draft(), draft({ claim_id: "x:2", final_status: "defer", missing: [] })], ctx());
    expect(res.every((r) => r.stored === false)).toBe(true);
    expect(res[1].validation.fail.join()).toMatch(/missing/);
    expect(existsSync(store)).toBe(false);
  });

  it("is append-only: an existing prefix is never rewritten, and duplicates are refused", () => {
    writeRecords([draft()], ctx());
    const before = readFileSync(store, "utf8");
    const dup = writeRecords([draft()], ctx());
    expect(dup[0].validation.fail.join()).toMatch(/duplicate/);
    writeRecords([draft({ claim_id: "critic:x:other" })], ctx());
    expect(readFileSync(store, "utf8").startsWith(before)).toBe(true);
  });

  it("fails closed without a provenance commit", () => {
    const [res] = writeRecords([draft()], { ...ctx(), commit: undefined });
    expect(res.stored).toBe(false);
  });

  it("refuses a revision of an unknown record", () => {
    const [res] = writeRecords([draft({ revises: "TR-000000000000" })], ctx());
    expect(res.validation.fail.join()).toMatch(/unknown record/);
  });
});

describe("consumer contract", () => {
  it("fails closed: CLEAR on a defer is refused, CLEAR on an accept is stored", () => {
    const [d] = writeRecords([draft({ claim_id: "c:d", final_status: "defer", missing: ["a measurement"], evidence: [] })], ctx());
    const [a] = writeRecords([draft()], ctx());
    const bad = appendActions([{ record_id: d.record_id, consumer: "loop", action: "CLEAR" }], ctx());
    expect(bad[0].stored).toBe(false);
    expect(bad[0].validation.fail.join()).toMatch(/fail closed/);
    const ok = appendActions([{ record_id: a.record_id, consumer: "loop", action: "CLEAR", ref: "LP-001" }], ctx());
    expect(ok[0].stored).toBe(true);
    const hold = appendActions([{ record_id: d.record_id, consumer: "loop", action: "HOLD" }], ctx());
    expect(hold[0].stored).toBe(true);
  });

  it("refuses to act on an unknown record and to CLEAR a superseded one", () => {
    expect(appendActions([{ record_id: "TR-000000000000", consumer: "loop", action: "HOLD" }], ctx())[0].stored).toBe(false);
    const [first] = writeRecords([draft({ final_status: "defer", missing: ["browser repro"], evidence: [] })], ctx());
    writeRecords([draft({ revises: first.record_id, reason: "repro'd in browser", evidence: [{ kind: "browser", ref: "localhost:3000 /" }] })], { ...ctx(), now: "2026-10-07T12:05:00.000Z" });
    const res = appendActions([{ record_id: first.record_id, consumer: "loop", action: "CLEAR" }], ctx());
    expect(res[0].stored).toBe(false);
  });

  it("replay + latestByClaim follow the revision chain", () => {
    const [first] = writeRecords([draft({ final_status: "defer", missing: ["x"], evidence: [] })], ctx());
    const [second] = writeRecords([draft({ revises: first.record_id })], { ...ctx(), now: "2026-10-07T12:01:00.000Z" });
    const state = replay(loadEntries(store), schema, POLICY);
    expect(state.errors).toEqual([]);
    expect(state.superseded.has(first.record_id)).toBe(true);
    expect(latestByClaim(state.records, state.superseded).get("critic:qa-e2e:missing-test").record_id).toBe(second.record_id);
  });

  it("replay refuses records written under a newer policy (version legibility)", () => {
    writeRecords([draft()], { ...ctx(), policyVersion: POLICY + 1 });
    const state = replay(loadEntries(store), schema, POLICY);
    expect(state.errors.join()).toMatch(/newer than this reader/);
  });

  it("replay reports corrupted lines instead of skipping them", () => {
    writeFileSync(store, "{not json\n");
    expect(replay(parseLines(readFileSync(store, "utf8"), store), schema, POLICY).errors[0]).toMatch(/invalid JSON/);
  });
});

describe("re-audit, rotation, metrics", () => {
  it("pathFromRef extracts repo paths from file:line refs", () => {
    expect(pathFromRef("src/lib/greeting.ts:12")).toBe("src/lib/greeting.ts");
    expect(pathFromRef("src/a.tsx:3-9")).toBe("src/a.tsx");
    expect(pathFromRef("the whole app")).toBeNull();
  });

  it("re-audits licensing records whose evidence file changed since their commit", () => {
    writeRecords([draft()], ctx());
    const state = replay(loadEntries(store), schema, POLICY);
    const cands = reauditCandidates(state.records, state.superseded, (commit, path) => commit === COMMIT && path === "e2e/remember-me.spec.ts");
    expect(cands).toHaveLength(1);
    expect(reauditCandidates(state.records, state.superseded, () => false)).toHaveLength(0);
  });

  it("rotates losslessly into yearly archives", () => {
    const drafts = Array.from({ length: 12 }, (_, i) => draft({ claim_id: `c:${i}` }));
    writeRecords(drafts, ctx());
    const before = loadEntries(store).map((e) => e.value.record_id);
    const res = rotateStore(store, { max: 10, keep: 4 });
    expect(res.moved).toBe(8);
    expect(readdirSync(dir)).toContain("2026.jsonl");
    expect(loadEntries(store).map((e) => e.value.record_id)).toEqual(before);
  });

  it("storeMetrics reports consumer coverage, defer quality and recurrence", () => {
    const [d] = writeRecords([draft({ claim_id: "c:1", final_status: "defer", missing: ["m"], evidence: [] })], ctx());
    writeRecords([draft({ claim_id: "c:1", revises: d.record_id })], { ...ctx(), now: "2026-10-07T12:01:00.000Z", commit: "fff1234aaaa0" });
    const [a] = writeRecords([draft({ claim_id: "c:2" })], ctx());
    writeRecords([draft({ claim_id: "c:2", reason: "again" })], { ...ctx(), commit: "eee1234bbbb0", now: "2026-10-07T13:00:00.000Z" });
    appendActions([{ record_id: a.record_id, consumer: "loop", action: "CLEAR" }], ctx());
    const m = storeMetrics(replay(loadEntries(store), schema, POLICY));
    expect(m.deferQuality).toBe(1);
    expect(m.repeatedErrorRate).toBe(0.5);
    expect(m.consumerCoverage).toBe(0);
  });
});

describe("tree fingerprint (verdict-reuse key)", () => {
  it("is stable for identical state and changes with any uncommitted edit", () => {
    const base = { head: "abc", diff: "", untracked: [] };
    expect(treeFingerprint(base)).toBe(treeFingerprint({ ...base }));
    expect(treeFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(treeFingerprint({ ...base, diff: "+x" })).not.toBe(treeFingerprint(base));
    expect(treeFingerprint({ ...base, untracked: [{ path: "a.ts", content: "1" }] })).not.toBe(treeFingerprint(base));
    expect(treeFingerprint({ ...base, head: "abd" })).not.toBe(treeFingerprint(base));
  });

  it("ignores untracked-file ordering", () => {
    const a = [{ path: "a", content: "1" }, { path: "b", content: "2" }];
    expect(treeFingerprint({ head: "h", untracked: a })).toBe(treeFingerprint({ head: "h", untracked: [...a].reverse() }));
  });
});

describe("bench metrics", () => {
  it("effective panel size follows Proposition 4", () => {
    expect(effectivePanelSize(10, 0)).toBe(10);
    expect(effectivePanelSize(10, 1)).toBe(1);
    expect(effectivePanelSize(5, 0.5)).toBeCloseTo(5 / 3);
  });

  it("mean pairwise correlation of identical error vectors is 1", () => {
    expect(meanPairwiseCorrelation([[1, 0, 1, 0], [1, 0, 1, 0]])).toBeCloseTo(1);
    expect(meanPairwiseCorrelation([[0, 0], [1, 0]])).toBeNull();
  });

  it("scores WrongAcceptRate, invariance, judge gap and raises pre-registered flags", () => {
    const manifest = {
      fixtures: [
        { id: "B1", kind: "bad", judge: { catches: true } },
        { id: "B2", kind: "bad", judge: { catches: false } },
        { id: "G1", kind: "good" },
      ],
    };
    const runs = [
      { arm: "verifier", repeat: 0, fixtureId: "B1", verdict: "reject", preGateVerdict: "reject" },
      { arm: "verifier", repeat: 0, fixtureId: "B2", verdict: "accept", preGateVerdict: "accept" },
      { arm: "verifier", repeat: 0, fixtureId: "G1", verdict: "accept", preGateVerdict: "accept" },
      { arm: "verifier", repeat: 1, fixtureId: "B1", verdict: "reject", preGateVerdict: "reject" },
      { arm: "verifier", repeat: 1, fixtureId: "B2", verdict: "reject", preGateVerdict: "reject" },
      { arm: "verifier", repeat: 1, fixtureId: "G1", verdict: "accept", preGateVerdict: "accept" },
      { arm: "single-pass", fixtureId: "B1", block: true },
      { arm: "single-pass", fixtureId: "B2", block: true },
      { arm: "single-pass", fixtureId: "G1", block: false },
      { arm: "panel", critic: "a", fixtureId: "B1", block: true },
      { arm: "panel", critic: "a", fixtureId: "B2", block: false },
      { arm: "panel", critic: "a", fixtureId: "G1", block: false },
      { arm: "panel", critic: "b", fixtureId: "B1", block: true },
      { arm: "panel", critic: "b", fixtureId: "B2", block: false },
      { arm: "panel", critic: "b", fixtureId: "G1", block: false },
    ];
    const s = scoreBench(manifest, { runs });
    expect(s.arms.verifier.wrongAcceptRate).toBeCloseTo(0.25);
    expect(s.arms.verifier.falseHoldRate).toBe(0);
    expect(s.arms.verifier.proceduralInvariance).toBeCloseTo(2 / 3);
    expect(s.externalJudgeGap.both).toEqual(["B1"]);
    expect(s.externalJudgeGap.neither).toEqual(["B2"]);
    expect(s.arms.panel.effectivePanelSize).toBeCloseTo(1);
    expect(s.flags.some((f) => f.startsWith("F1"))).toBe(true);
    expect(s.flags.some((f) => f.startsWith("F3"))).toBe(true);
  });
});
