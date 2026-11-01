import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_ALLOWED,
  EVIDENCE_POLICY,
  VERDICTS,
  applyEvidenceGate,
  applyEvidenceGateStrict,
  staleFixtures,
  appendActions,
  benchRecordDraft,
  BRIEF_WINDOW,
  briefRecords,
  contaminatedRuns,
  effectivePanelSize,
  insideRepo,
  l3Check,
  loadWorkflowBlock,
  markUnscanned,
  opaqueFixtureId,
  numstatPaths,
  runKeyFromLabel,
  unmatchedLeaks,
  latestByClaim,
  leakyFiles,
  loadEntries,
  loadSchema,
  meanPairwiseCorrelation,
  parseLines,
  pathFromRef,
  readPolicyVersion,
  reauditCandidates,
  replay,
  ROOT,
  rotateStore,
  schemaKeywordViolations,
  scoreBench,
  semanticViolations,
  storeMetrics,
  treeFingerprint,
  validate,
  VERIFIER_FILE,
  verifierBlockHash,
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

describe("checker-round hardening (policy v2)", () => {
  it("a qualify on reading-only evidence is deferred for factual/measured/normative/practical, kept for causal/predictive", () => {
    const q = (claimType) => applyEvidenceGate({ verdict: "qualify", qualifier: "weaker", claimType, evidenceChecked: [{ kind: "reading", ref: "x" }] }).verdict;
    expect(["factual", "measured", "normative", "practical"].map(q)).toEqual(["defer", "defer", "defer", "defer"]);
    expect(["causal", "predictive"].map(q)).toEqual(["qualify", "qualify"]);
  });

  it("the strict gate keeps the most conservative outcome across claim types", () => {
    const v = { verdict: "accept", evidenceChecked: [{ kind: "file_line", ref: "a.ts:1" }] };
    expect(applyEvidenceGateStrict(v, ["factual"]).verdict).toBe("accept");
    expect(applyEvidenceGateStrict(v, ["factual", "measured"]).verdict).toBe("defer");
    expect(applyEvidenceGateStrict(v, ["factual", "causal"]).verdict).toBe("qualify");
  });

  it("semantic rules are policy-versioned: the v2 qualify floor does not retroactively break v1 records", () => {
    const rec = { final_status: "qualify", qualifier: "weaker", claim_type: "factual", evidence: [{ kind: "reading", ref: "x" }], missing: [] };
    expect(semanticViolations({ ...rec, policy_version: "1" })).toEqual([]);
    expect(semanticViolations({ ...rec, policy_version: "2" }).join()).toMatch(/qualify of a factual claim/);
  });

  it("writing the same draft twice (different time) is refused as duplicate content", () => {
    writeRecords([draft()], ctx());
    const [again] = writeRecords([draft()], { ...ctx(), now: "2026-10-07T13:00:00.000Z" });
    expect(again.stored).toBe(false);
    expect(again.validation.fail.join()).toMatch(/duplicate content/);
  });

  it("the same action on DIFFERENT records gets distinct ids and is stored (an action's record_id is part of its identity)", () => {
    const res = writeRecords([draft({ claim_id: "c:a" }), draft({ claim_id: "c:b" })], ctx());
    const acts = appendActions(res.map((r) => ({ record_id: r.record_id, consumer: "loop", action: "HOLD", note: "same note" })), ctx());
    expect(acts.every((a) => a.stored)).toBe(true);
    expect(new Set(acts.map((a) => a.action_id)).size).toBe(2);
    expect(replay(loadEntries(store), schema, POLICY).errors).toEqual([]);
  });

  it("a duplicate decision is an idempotent no-op — never a batch failure, never a poisoned store", () => {
    const [a] = writeRecords([draft()], ctx());
    const res = appendActions([{ record_id: a.record_id, consumer: "loop", action: "HOLD" }, { record_id: a.record_id, consumer: "loop", action: "HOLD" }], ctx());
    expect(res.every((r) => r.stored)).toBe(true);
    expect(res[1].noop).toBe(true);
    const again = appendActions([{ record_id: a.record_id, consumer: "loop", action: "HOLD" }], { ...ctx(), now: "2026-10-07T14:00:00.000Z" });
    expect(again[0].noop).toBe(true);
    expect(loadEntries(store).filter((e) => e.value.kind === "action")).toHaveLength(1);
    expect(replay(loadEntries(store), schema, POLICY).errors).toEqual([]);
  });

  it("REUSE is an event: the same one at a later time is stored again", () => {
    const [a] = writeRecords([draft()], ctx());
    appendActions([{ record_id: a.record_id, consumer: "critic-panel", action: "REUSE", note: "same" }], ctx());
    const second = appendActions([{ record_id: a.record_id, consumer: "critic-panel", action: "REUSE", note: "same" }], { ...ctx(), now: "2026-10-07T15:00:00.000Z" });
    expect(second[0].stored).toBe(true);
    expect(second[0].noop).toBeUndefined();
    expect(loadEntries(store).filter((e) => e.value.kind === "action")).toHaveLength(2);
  });

  it("a union-merged store replays without errors (order-dependent checks are warnings on replay)", () => {
    // Common base: r1. Branch A adds a newer record r2 for the same claim; branch B CLEARs r1.
    const [r1] = writeRecords([draft()], ctx());
    const base = readFileSync(store, "utf8");
    writeRecords([draft({ reason: "branch a revisited it" })], { ...ctx(), now: "2026-10-07T13:00:00.000Z" });
    const a = readFileSync(store, "utf8").slice(base.length);
    writeFileSync(store, base);
    appendActions([{ record_id: r1.record_id, consumer: "loop", action: "CLEAR" }], ctx());
    const b = readFileSync(store, "utf8").slice(base.length);
    writeFileSync(store, base + a + b); // what merge=union produces: base, then ours, then theirs
    const state = replay(loadEntries(store), schema, POLICY);
    expect(state.errors).toEqual([]);
    expect(state.warnings.join()).toMatch(/order-dependent/);
  });

  it("action notes are screened for secrets and bench ground truth like records", () => {
    const [a] = writeRecords([draft()], ctx());
    const res = appendActions([{ record_id: a.record_id, consumer: "loop", action: "HOLD", note: "key sk-ant-abcdefghijklmnopqrstuvwx" }], ctx());
    expect(res[0].stored).toBe(false);
    const res2 = appendActions([{ record_id: a.record_id, consumer: "loop", action: "HOLD", note: "see B99-secret-fixture" }], { ...ctx(), forbidden: ["B99-secret-fixture"] });
    expect(res2[0].stored).toBe(false);
  });

  it("a draft with a prototype-polluting key is refused, not stored", () => {
    const [res] = writeRecords([JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(draft()).slice(1)}`)], ctx());
    expect(res.stored).toBe(false);
    expect(res.validation.fail.join()).toMatch(/prototype-polluting/);
  });

  it("CLEAR is refused on an older record once a newer record exists for the same claim (no revises link needed)", () => {
    const [older] = writeRecords([draft()], ctx());
    writeRecords([draft({ final_status: "reject", reason: "refuted later", evidence: [] })], { ...ctx(), now: "2026-10-07T13:00:00.000Z" });
    const res = appendActions([{ record_id: older.record_id, consumer: "loop", action: "CLEAR" }], ctx());
    expect(res[0].validation.fail.join()).toMatch(/newer record for claim/);
  });

  it("lint detects a record edited in place (ids are content hashes)", () => {
    writeRecords([draft()], ctx());
    const line = readFileSync(store, "utf8").replace("The cleared-name path", "Some other path");
    writeFileSync(store, line);
    expect(replay(loadEntries(store), schema, POLICY).errors.join()).toMatch(/edited in place/);
  });

  it("the writer refuses drafts that would leak bench ground truth into the store", () => {
    const [res] = writeRecords([draft({ claim_text: "B99-secret-fixture escapes tests" })], { ...ctx(), forbidden: ["B99-secret-fixture"] });
    expect(res.stored).toBe(false);
    expect(res.validation.fail.join()).toMatch(/bench ground truth/);
  });

  it("validate() does not let __proto__ keys slip past additionalProperties:false", () => {
    const rec = JSON.parse('{"__proto__": {"x": 1}}');
    expect(validate(schema.$defs.action, rec, schema).join()).toMatch(/unknown property "__proto__"/);
  });

  it("staleFixtures reports patches that no longer apply (by opaque token only)", () => {
    const manifest = { fixtures: [{ id: "B01-a", patch: "p1" }, { id: "G01-b", patch: "p2" }] };
    const stale = staleFixtures(manifest, (p) => p === "p1");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/^fx-[0-9a-f]{8}$/);
  });

  it("bench scoring excludes no-verdict runs, raises F4 on an undefended wrong accept, and drafts a qualified record", async () => {
    const { benchRecordDraft } = await import("./lib.mjs");
    const manifest = { fixtures: [{ id: "B1", kind: "bad" }, { id: "G1", kind: "good" }] };
    const runs = [
      { arm: "verifier", repeat: 0, fixtureId: "B1", verdict: "accept", preGateVerdict: "accept" },
      { arm: "verifier", repeat: 0, fixtureId: "G1", verdict: "defer", noVerdict: true },
    ];
    const s = scoreBench(manifest, { runs });
    expect(s.noVerdictRuns).toBe(1);
    expect(s.flags.some((f) => f.startsWith("F4"))).toBe(true);
    expect(s.arms.verifier.falseHoldRate).toBeNull();
    expect(benchRecordDraft(s, { resultsRef: "r.json" }).final_status).toBe("qualify");
  });

  it("storeMetrics raises F5 when most current claims were never acted on (REUSE/REAUDIT do not count)", () => {
    const drafts = Array.from({ length: 10 }, (_, i) => draft({ claim_id: `c:${i}` }));
    const res = writeRecords(drafts, ctx());
    appendActions([{ record_id: res[0].record_id, consumer: "critic-panel", action: "REUSE" }], ctx());
    const m = storeMetrics(replay(loadEntries(store), schema, POLICY));
    expect(m.consumerCoverage).toBe(0);
    expect(m.flags.some((f) => f.startsWith("F5"))).toBe(true);
  });
});

// Policy v3, the memory write boundary: external content is attribution, never licensing
// evidence for a wiki fact. Only the deterministic part; evidence kinds stay the writer's word.
describe("memory write boundary (policy v3)", () => {
  const v3 = () => ({ ...ctx(), policyVersion: 3 });
  const fact = (evidence, over = {}) =>
    draft({ writer_id: "dream", claim_id: "wiki:testing:vitest-parallel", claim_text: "Vitest runs test files in parallel", evidence, provenance: { workflow: "dream" }, ...over });
  const why = (res) => (res.validation === "pass" ? "" : res.validation.fail.join("\n"));
  // A defer has no evidence floor, so only the boundary can fire on it.
  const wikiDefer = (evidence) => ({ claim_id: "wiki:testing:x", policy_version: "3", final_status: "defer", missing: ["a local reproduction"], evidence });

  it("the policy page declares v3 or later, so `pnpm trace write` stamps new records under the boundary", () => {
    expect(POLICY).toBeGreaterThanOrEqual(3);
  });

  it("refuses a wiki record whose observation evidence is an external URL or a path outside the repo", () => {
    const refused = [
      [{ kind: "file_line", ref: "https://example.com/x" }, /URL/],
      [{ kind: "browser", ref: "http://localhost:3000@evil.example/" }, /URL/], // userinfo: the host is evil.example
      [{ kind: "file_line", ref: "/tmp/page.html:3" }, /repo-relative/],
      [{ kind: "file_line", ref: "../x.md" }, /repo-relative/],
    ];
    for (const [i, [item, reason]] of refused.entries()) {
      const [res] = writeRecords([fact([item], { claim_id: `wiki:testing:refused-${i}` })], v3());
      expect(res.stored, item.ref).toBe(false);
      expect(why(res), item.ref).toMatch(reason);
    }
    expect(existsSync(store)).toBe(false);
  });

  it("stores external content cited as reading, an external-only defer, localhost observations, a WCAG rule URL and non-wiki records", () => {
    const external = { kind: "reading", ref: "external:https://example.com/blog/vitest-parallelism" };
    const drafts = [
      fact([external, { kind: "command", ref: "pnpm exec vitest --help | grep fileParallelism" }]),
      fact([external], { claim_id: "wiki:testing:external-only", final_status: "defer", missing: ["a local reproduction"] }),
      fact([{ kind: "browser", ref: "http://localhost:3000/settings renders the form" }], { claim_id: "wiki:testing:localhost" }),
      fact([{ kind: "browser", ref: "http://0.0.0.0:3000" }], { claim_id: "wiki:testing:all-interfaces" }),
      fact([{ kind: "browser", ref: "http://myapp.localhost:3000" }], { claim_id: "wiki:testing:dot-localhost" }),
      fact([{ kind: "rule", ref: "https://www.w3.org/TR/WCAG22/#contrast-minimum" }], { claim_id: "wiki:quality-bar:contrast", claim_type: "normative" }),
      draft({ evidence: [{ kind: "file_line", ref: "https://example.com/x" }] }), // a critic record: out of scope
    ];
    const res = writeRecords(drafts, v3());
    expect(res.map(why)).toEqual(drafts.map(() => ""));
    expect(res.every((r) => r.stored)).toBe(true);
  });

  it("is version-gated: a v2 record with a URL ref still replays clean", () => {
    const [res] = writeRecords([fact([{ kind: "file_line", ref: "https://example.com/x" }])], { ...ctx(), policyVersion: 2 });
    expect(res.stored).toBe(true);
    expect(replay(loadEntries(store), schema, POLICY).errors).toEqual([]);
    const rec = loadEntries(store)[0].value;
    expect(semanticViolations(rec)).toEqual([]);
    expect(semanticViolations({ ...rec, policy_version: "3" }).join()).toMatch(/URL/);
  });

  it("reading alone never licenses a wiki fact: a causal or predictive qualify on external content is refused, though the gate falls back to qualify for those types", () => {
    const external = { kind: "reading", ref: "external:https://example.com/blog/vitest-parallelism" };
    const qualified = (claim_type, evidence) =>
      fact(evidence, { claim_id: `wiki:testing:${claim_type}-${evidence.length}`, claim_type, final_status: "qualify", qualifier: "reported by one blog post" });
    for (const claimType of ["causal", "predictive"]) {
      const [res] = writeRecords([qualified(claimType, [external])], v3());
      expect(res.stored, claimType).toBe(false);
      expect(why(res), claimType).toMatch(/needs evidence other than reading/);
    }
    expect(existsSync(store)).toBe(false);
    // The same attribution beside a local check run this session is stored.
    const [res] = writeRecords([qualified("causal", [external, { kind: "command", ref: "pnpm exec vitest run scripts/trace/lib.test.mjs" }])], v3());
    expect(why(res)).toBe("");
    expect(res.stored).toBe(true);
  });

  it("the reading rule binds licensing verdicts on wiki claims only, and older records replay unchanged", () => {
    const external = { kind: "reading", ref: "external:https://example.com/blog/vitest-parallelism" };
    const rec = { claim_id: "wiki:testing:x", policy_version: "3", claim_type: "causal", final_status: "qualify", qualifier: "weaker", evidence: [external], missing: [] };
    expect(semanticViolations(rec).join()).toMatch(/needs evidence other than reading/);
    expect(semanticViolations({ ...rec, final_status: "accept" }).join()).toMatch(/needs evidence other than reading/);
    // A defer on reading alone is the quarantine path; revise and reject license nothing.
    for (const withheld of [{ final_status: "defer", missing: ["a local reproduction"] }, { final_status: "revise", repair: "restate it" }, { final_status: "reject" }]) {
      expect(semanticViolations({ ...rec, ...withheld }), withheld.final_status).toEqual([]);
    }
    // Out of scope: a critic record keeps the gate's "code reading only" qualify fallback.
    expect(semanticViolations({ ...rec, claim_id: "critic:qa-e2e:x" })).toEqual([]);
    const [old] = writeRecords([fact([external], { claim_id: "wiki:testing:v2-causal", claim_type: "causal", final_status: "qualify", qualifier: "weaker" })], { ...ctx(), policyVersion: 2 });
    expect(old.stored).toBe(true);
    expect(replay(loadEntries(store), schema, POLICY).errors).toEqual([]);
  });

  it("checks every evidence kind except rule, human, record and reading, whatever the verdict", () => {
    const kinds = schema.$defs.evidenceItem.properties.kind.enum;
    const refused = kinds.filter((kind) => semanticViolations(wikiDefer([{ kind, ref: "https://example.com/x" }])).length > 0);
    expect(refused).toEqual(["file_line", "command", "browser", "measurement", "diff"]);
  });

  it("reads each URL as the URL parser does: to the next space, every URL in the ref, unparsable fails closed", () => {
    const urlViolations = (ref, kind = "browser") => semanticViolations(wikiDefer([{ kind, ref }]));
    for (const ref of [
      "http://localhost'@evil.example/", // a quote or bracket does not end the URL: the parser reads it as userinfo
      "http://localhost(@evil.example/",
      "http://localhost:3000/login?next=https://evil.example/", // a URL inside a local one
      "http://localhost:99999/", // unparsable
      "file:///tmp/page.html", // a saved page, not a repo file
      "http://localhost.evil.example/", // a host under evil.example, not under .localhost
      "http://evillocalhost/", // *.localhost means a whole "localhost" label after a dot
      "HTTPS://EVIL.EXAMPLE/x", // the scheme is case-insensitive
      "(http://[::1]@evil.example)", // dropping trailing punctuation never drops the "@": the host stays evil.example
    ]) {
      expect(urlViolations(ref).join(), ref).toMatch(/URL/);
    }
    // Local: prose punctuation after the URL is not part of it (typographic closing quotes
    // too), but a bare IPv6 host keeps its "]".
    for (const ref of [
      "http://localhost:3000, then /about",
      "(http://localhost:3000)",
      "http://[::1]:3000/",
      "http://[::1]",
      "(http://[::1])", // the ")" goes, the "]" the IPv6 host needs stays
      "see http://127.0.0.1:3000/api/health.",
      "open http://localhost.", // it parses as host "localhost." first; the shorter reading still counts
      "axe on “http://localhost:3000”: 0 violations",
      "‘http://localhost:3000’",
      "«http://localhost:3000»",
    ]) {
      expect(urlViolations(ref), ref).toEqual([]);
    }
    expect(urlViolations("curl -s http://localhost:3000/api/health", "command")).toEqual([]);
    expect(urlViolations("curl -s https://registry.npmjs.org/next", "command").join()).toMatch(/URL/); // re-fetching the source is not a reproduction
  });

  it("a wiki file_line must be a repo path: no leading / or ~, no drive letter, no .. segment", () => {
    const pathViolations = (ref) => semanticViolations(wikiDefer([{ kind: "file_line", ref }]));
    // Leading whitespace hides nothing: reaudit reads the path trimmed (pathFromRef), so the guard does too.
    for (const ref of ["/tmp/page.html:3", "../x.md", "docs/../../x.md", "~/notes.md", "C:\\notes.md", " /tmp/page.html:3", "\t../x.md:3"]) {
      expect(pathViolations(ref).join(), JSON.stringify(ref)).toMatch(/repo-relative/);
    }
    for (const ref of ["scripts/trace/lib.mjs:199-224", "./README.md", ".claude/memory/topics/trace.md", "docs/..notes.md"]) {
      expect(pathViolations(ref), ref).toEqual([]);
    }
    // Only a file_line names repo evidence: a command may run a path anywhere.
    expect(semanticViolations(wikiDefer([{ kind: "command", ref: "/usr/bin/node /tmp/sigdemo.mjs" }]))).toEqual([]);
  });

  it("a wiki diff ref names repo paths too: each comma-separated part, trimmed, as reaudit reads it", () => {
    for (const [i, ref] of ["/tmp/fix.patch", "src/a.ts, ../x.patch", " /tmp/fix.patch"].entries()) {
      const [res] = writeRecords([fact([{ kind: "diff", ref }], { claim_id: `wiki:testing:diff-refused-${i}` })], v3());
      expect(res.stored, JSON.stringify(ref)).toBe(false);
      expect(why(res), JSON.stringify(ref)).toMatch(/repo-relative/);
    }
    expect(existsSync(store)).toBe(false);
    const [res] = writeRecords([fact([{ kind: "diff", ref: "src/a.ts, src/b.ts" }], { claim_id: "wiki:testing:diff-stored" })], v3());
    expect(why(res)).toBe("");
    expect(res.stored).toBe(true);
  });

  // The boundary follows the commit, not the claim id: the checks above screen only a wiki: record, so no other record
  // is ever COMMITted to a topic page or QUARANTINEd. Append time only — replay is unchanged (wiki.test.mjs).
  it("follows the commit: a COMMIT or COMMIT_QUALIFIED whose ref is under topics/ (read as wiki-check reads refs) and any QUARANTINE are refused on a non-wiki: record; any other ref, any other action and every wiki: record are stored", () => {
    const [critic, criticQ, criticD, wiki, wikiQ, wikiD] = writeRecords(
      [
        draft(),
        draft({ claim_id: "critic:ux:q", final_status: "qualify", qualifier: "on one run" }),
        draft({ claim_id: "critic:ux:d", final_status: "defer", missing: ["a browser repro"], evidence: [] }),
        fact([{ kind: "file_line", ref: "vitest.config.ts:8" }]),
        fact([{ kind: "file_line", ref: "vitest.config.ts:8" }], { claim_id: "wiki:testing:q", final_status: "qualify", qualifier: "on one run" }),
        fact([], { claim_id: "wiki:testing:d", final_status: "defer", missing: ["a local reproduction"] }),
      ],
      v3(),
    ).map((r) => r.record_id);
    const one = (record_id, action, ref) => appendActions([{ record_id, consumer: "dream", action, ...(ref ? { ref } : {}) }], ctx())[0];
    const pageRefs = ["topics/x.md", "./topics/x.md", ".claude/memory/topics/x.md", "./.claude/memory/topics/x.md", "topics/sub/x.md"];
    for (const ref of pageRefs) {
      const res = one(critic, "COMMIT", ref);
      expect(res.stored, ref).toBe(false);
      expect(why(res), ref).toMatch(/is not a wiki: record — .*re-admit the fact through \/dream as wiki:<topic>:<slug>/);
      expect(one(criticQ, "COMMIT_QUALIFIED", ref).stored, ref).toBe(false);
    }
    for (const ref of ["quarantine.md", undefined]) expect(one(criticD, "QUARANTINE", ref).stored, String(ref)).toBe(false);
    expect(existsSync(store) && readFileSync(store, "utf8").includes('"kind":"action"')).toBe(false);
    for (const ref of ["US-001", "docs/wiki/billing.md", undefined]) expect(one(critic, "COMMIT", ref).stored, String(ref)).toBe(true);
    expect(one(criticD, "HOLD").stored).toBe(true);
    for (const ref of pageRefs) expect(one(wiki, "COMMIT", ref).stored, ref).toBe(true);
    expect(one(wikiQ, "COMMIT_QUALIFIED", "topics/x.md").stored).toBe(true);
    expect(one(wikiD, "QUARANTINE", "quarantine.md").stored).toBe(true);
    expect(replay(loadEntries(store), schema, POLICY).errors).toEqual([]);
  });
});

describe("secrets never enter the store", () => {
  it("the writer refuses a draft that looks like it carries a secret", () => {
    const [res] = writeRecords([draft({ claim_text: "key is sk-ant-abcdefghijklmnopqrstuvwx" })], ctx());
    expect(res.stored).toBe(false);
    expect(res.validation.fail.join()).toMatch(/secret/);
  });
});

describe("bench scoring fails closed on unattributable leaks", () => {
  it("raises F0 when a leak cannot be tied to a run", () => {
    const s = scoreBench({ fixtures: [{ id: "B1", kind: "bad" }, { id: "G1", kind: "good" }] }, { runs: [], unattributedLeaks: 1 });
    expect(s.flags.some((f) => f.startsWith("F0 contamination") && f.includes("could not be tied"))).toBe(true);
  });
});

describe("bench run accounting (a run that never came back still counts)", () => {
  const manifest = { fixtures: [{ id: "B1", kind: "bad" }, { id: "G1", kind: "good" }] };
  const runs = [
    { arm: "verifier", repeat: 0, fixtureId: "B1", verdict: "reject", preGateVerdict: "reject" },
    { arm: "verifier", repeat: 0, fixtureId: "G1", verdict: "accept", preGateVerdict: "accept" },
  ];

  it("runs the workflow started but never returned are missingRuns: F0 validity, and the record is a qualify", () => {
    const s = scoreBench(manifest, { runs, expectedRuns: 3 });
    expect(s.missingRuns).toBe(1);
    expect(s.flags.some((f) => f.startsWith("F0 validity: 1 run(s) missing"))).toBe(true);
    const rec = benchRecordDraft(s, { resultsRef: "r.json" });
    expect(rec.final_status).toBe("qualify");
    expect(rec.qualifier).toMatch(/1 run\(s\) missing/);
  });

  it("when every started run came back nothing is missing, and a clean bench still records an accept", () => {
    const s = scoreBench(manifest, { runs, expectedRuns: 2 });
    expect(s.missingRuns).toBe(0);
    expect(s.flags.some((f) => f.startsWith("F0"))).toBe(false);
    expect(benchRecordDraft(s, { resultsRef: "r.json" }).final_status).toBe("accept");
  });
});

describe("round-3 fixes", () => {
  it("REAUDIT is a decision: re-auditing an unchanged queue is a no-op, changed evidence is a new action", () => {
    const [a] = writeRecords([draft()], ctx());
    const act = (note, now) => appendActions([{ record_id: a.record_id, consumer: "dream", action: "REAUDIT", note }], { ...ctx(), now });
    act("evidence changed: src/a.ts", NOW);
    const again = act("evidence changed: src/a.ts", "2026-10-08T09:00:00.000Z");
    expect(again[0]).toMatchObject({ stored: true, noop: true });
    expect(act("evidence changed: src/a.ts, src/b.ts", "2026-10-08T10:00:00.000Z")[0].noop).toBeUndefined();
    expect(loadEntries(store).filter((e) => e.value.kind === "action")).toHaveLength(2);
  });

  it("--brief keeps every field verdict reuse reads (a reused qualify keeps its qualifier) and the newest window only", () => {
    const recs = Array.from({ length: BRIEF_WINDOW + 3 }, (_, i) => ({
      record_id: `TR-${String(i).padStart(12, "0")}`, claim_id: `c${i}`, claim_text: "t", claim_type: "factual",
      final_status: "qualify", qualifier: `holds only for case ${i}`, repair: "", failed_gates: ["g"], missing: [],
      reason: "r".repeat(500), provenance: { commit: "abc1234", workflow: "critic-panel", tree: "0123456789abcdef" },
      created_at: `2026-10-07T12:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    const brief = briefRecords(recs);
    expect(brief).toHaveLength(BRIEF_WINDOW);
    expect(brief[0]).toMatchObject({ claim_id: `c${BRIEF_WINDOW + 2}`, qualifier: `holds only for case ${BRIEF_WINDOW + 2}`, failed_gates: ["g"], provenance: { tree: "0123456789abcdef" } });
    expect(brief[0].reason.length).toBe(200);
    expect(brief.some((r) => r.claim_id === "c0")).toBe(false); // the oldest fall out of the window
  });

  it("numstatPaths reads git's -z listing (plain and rename forms)", () => {
    expect(numstatPaths("1\t1\tsrc/a.ts\x000\t0\t.claude/loop.md\x00")).toEqual(["src/a.ts", ".claude/loop.md"]);
    expect(numstatPaths("0\t0\t\x00docs/x.md\x00.claude/loop.md\x00-\t-\timg.png\x00")).toEqual(["docs/x.md", ".claude/loop.md", "img.png"]);
  });

  it("insideRepo resolves relative paths against the cwd before comparing", () => {
    expect(insideRepo("tmp-unpack", "/repo", "/repo")).toBe(true);
    expect(insideRepo("../elsewhere", "/repo", "/repo")).toBe(false);
    expect(insideRepo("/repo-sibling/x", "/repo", "/")).toBe(false);
    expect(insideRepo("/repo/sub", "/repo", "/")).toBe(true);
  });

  it("agent labels map back to runs, including critic keys with digits and the run id", () => {
    expect(runKeyFromLabel("bench-panel:fx-0000abcd:qa-e2e-5-5@0a1b2c3d")).toEqual({ arm: "panel", token: "fx-0000abcd", critic: "qa-e2e", runId: "0a1b2c3d" });
    expect(runKeyFromLabel("bench-verify:fx-0000abcd-r1-3@0a1b2c3d")).toMatchObject({ arm: "verifier", repeat: 1, runId: "0a1b2c3d" });
    expect(runKeyFromLabel("critic:security-1")).toBeNull();
  });

  it("a transcript from another run (different run id) or an empty one covers nothing", () => {
    const run = { arm: "single-pass", fixtureId: "fx-00000001", runId: "0a1b2c3d", block: true };
    const label = "bench-single:fx-00000001-0";
    expect(markUnscanned([run], [{ label: `${label}@ffffffff`, text: "x" }])[0].unscanned).toBe(true);
    expect(markUnscanned([run], [{ label: `${label}@0a1b2c3d`, text: "  " }])[0].unscanned).toBe(true);
    expect(markUnscanned([run], [{ label: `${label}@0a1b2c3d`, text: "x" }])[0].unscanned).toBeUndefined();
  });

  it("leaks that belong to no scored run (unknown label, or another run's id) count as unattributed", () => {
    const runs = [{ arm: "single-pass", fixtureId: "fx-00000001", runId: "0a1b2c3d" }];
    const key = { arm: "single-pass", token: "fx-00000001" };
    expect(unmatchedLeaks(runs, [{ ...key, runId: "0a1b2c3d" }])).toBe(0);
    expect(unmatchedLeaks(runs, [{ ...key, runId: "ffff9999" }, { ...key }, { arm: "unknown", label: "x" }])).toBe(3);
  });

  it("runs no scanned transcript belongs to are excluded from the metrics (F0 coverage), and that alone makes the record a qualify", () => {
    const manifest = { fixtures: [{ id: "B10-x", kind: "bad" }, { id: "G10-y", kind: "good" }] };
    const [bad, good] = ["B10-x", "G10-y"].map(opaqueFixtureId);
    const runs = [
      { arm: "verifier", repeat: 0, fixtureId: bad, verdict: "accept" }, // a wrong accept — but nobody scanned its agent
      { arm: "verifier", repeat: 0, fixtureId: good, verdict: "accept" },
    ];
    const marked = markUnscanned(runs, [{ label: `bench-verify:${good}-r0-1`, text: "x" }, { label: "critic:security-1", text: "x" }]);
    expect(marked.map((r) => !!r.unscanned)).toEqual([true, false]);
    const score = scoreBench(manifest, { runs: marked });
    expect(score.unscannedRuns).toBe(1);
    expect(score.noVerdictRuns).toBe(0);
    expect(score.arms.verifier.wrongAcceptRate).toBeNull(); // the unscanned run was not scored
    expect(score.flags.some((f) => f.startsWith("F0 coverage"))).toBe(true);
    expect(benchRecordDraft(score, { resultsRef: "x" }).final_status).toBe("qualify");
  });

  it("a no-verdict run needs no transcript (it is excluded anyway)", () => {
    expect(markUnscanned([{ arm: "verifier", repeat: 1, fixtureId: "fx-00000002", noVerdict: true }], [])[0].unscanned).toBeUndefined();
  });

  it("a transcript covers only its own repeat and its own critic", () => {
    const v = { arm: "verifier", repeat: 0, fixtureId: "fx-00000001" };
    expect(markUnscanned([v], [{ label: "bench-verify:fx-00000001-r1-0", text: "x" }])[0].unscanned).toBe(true);
    const p = { arm: "panel", critic: "security", fixtureId: "fx-00000001" };
    expect(markUnscanned([p], [{ label: "bench-panel:fx-00000001:regression-0-0", text: "x" }])[0].unscanned).toBe(true);
    expect(markUnscanned([p], [{ label: "bench-panel:fx-00000001:security-0-0", text: "x" }])[0].unscanned).toBeUndefined();
  });

  it("loadWorkflowBlock evaluates a trusted copy when given one (denylist-check reads HEAD, not the working tree)", () => {
    const source = "// <loop-denylist>\nconst hitsDenylist = () => 'from-source'\n// </loop-denylist>\n";
    expect(loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist"], { source }).hitsDenylist()).toBe("from-source");
  });
});

// Both fixes come from the held-out bench run: the instrument, not the checker, produced
// its one excluded run and its one false hold.
describe("bench instrument: leak guard and F0 scan", () => {
  const synth = {
    fixtures: [
      {
        id: "B99-synthetic-only",
        kind: "bad",
        defect: "Synthetic defect prose that exists only inside this unit test file",
        patch: "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const freshlyAddedHelper = 1;\n",
      },
    ],
  };

  it("leak guard: a fixture applied as a new, untracked code file is code, not a leak — prose and ids still are", () => {
    const d = mkdtempSync(join(tmpdir(), "leak-guard-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: d });
      mkdirSync(join(d, "src"));
      mkdirSync(join(d, "docs"));
      // Clean tree: a patch-only token in prose is a leak.
      writeFileSync(join(d, "docs/notes.md"), "see freshlyAddedHelper\n");
      expect(leakyFiles(synth, d).files).toEqual(["docs/notes.md"]);
      // An untracked dump under a code path is NOT code: it must not whitelist itself
      // (or the prose above) — only files the fixture patches create count.
      mkdirSync(join(d, "scripts"));
      writeFileSync(join(d, "scripts/dump.txt"), synth.fixtures[0].patch);
      expect(leakyFiles(synth, d).files.sort()).toEqual(["docs/notes.md", "scripts/dump.txt"]);
      rmSync(join(d, "scripts/dump.txt"));
      // The fixture applied (what a verifier's worktree holds): its new file is not a leak.
      writeFileSync(join(d, "src/new.ts"), "export const freshlyAddedHelper = 1;\n");
      expect(leakyFiles(synth, d).files).not.toContain("src/new.ts");
      // A fixture id or defect prose is ground truth wherever it lands, code included.
      writeFileSync(join(d, "src/dump.ts"), "// B99-synthetic-only\n");
      expect(leakyFiles(synth, d).files).toContain("src/dump.ts");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("F0 counts a marker only where the agent RECEIVED it — its own messages and structured-output echo are its measured output", () => {
    const label = "bench-verify:fx-0000beef-r0-0";
    const defect = synth.fixtures[0].defect.slice(0, 60);
    const line = (o) => JSON.stringify(o);
    const own = [
      line({ type: "user", message: { role: "user", content: "review this diff" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: defect }] } }),
      line({ type: "attachment", attachment: { type: "structured_output", data: { reason: defect } } }),
    ].join("\n");
    expect(contaminatedRuns([{ label, text: own }], synth)).toEqual([]);
    // Received through a tool result, even after the agent wrote it itself: a leak.
    const toolResult = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: `... ${defect} ...` }] } });
    expect(contaminatedRuns([{ label, text: `${own}\n${toolResult}` }], synth)).toHaveLength(1);
    // Injected context (any attachment but the structured-output echo): a leak.
    const injected = line({ type: "attachment", attachment: { type: "instructions", content: synth.fixtures[0].id } });
    expect(contaminatedRuns([{ label, text: injected }], synth)).toHaveLength(1);
    // A line that does not parse counts as received (fail closed).
    expect(contaminatedRuns([{ label, text: `{"type":"assistant", ${defect}` }], synth)).toHaveLength(1);
  });
});

// L3 freshness: a bench record names the <loop-verifier> block it measured by its sha256, so a
// verifier edited after the bench no longer passes as measured. `pnpm trace l3-check` is
// loop-checklist.md's measured-checker item, computed from the latest bench record.
describe("L3 freshness: bench records name the verifier they measured", () => {
  const block = "// <loop-verifier>\nfunction verifierPrompt() { return 'v1' }\n// </loop-verifier>\n";
  const source = `const before = 1\n${block}const after = 2\n`;
  const sha = (text) => createHash("sha256").update(text).digest("hex");

  it("verifierBlockHash is the sha256 of the <loop-verifier> block, marker lines included: only an edit inside the block changes it", () => {
    expect(verifierBlockHash(source)).toBe(sha(block));
    expect(verifierBlockHash(source.replace("const after = 2", "const after = 3"))).toBe(sha(block));
    expect(verifierBlockHash(source.replace("'v1'", "'v2'"))).not.toBe(sha(block));
    expect(verifierBlockHash("const noBlock = 1\n")).toBeNull();
    // The production file carries the block: renamed markers must not quietly strip every bench record's hash.
    expect(VERIFIER_FILE).toBe(".claude/workflows/loop-iteration.js");
    expect(verifierBlockHash(readFileSync(join(ROOT, VERIFIER_FILE), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("benchRecordDraft carries the hash it is given as a file_line item on loop-iteration.js; the writer stores it and l3-check accepts it", () => {
    const manifest = { fixtures: [{ id: "B1", kind: "bad" }, { id: "G1", kind: "good" }] };
    const runs = [0, 1].flatMap((repeat) => [
      { arm: "verifier", repeat, fixtureId: "B1", verdict: "reject", preGateVerdict: "reject" },
      { arm: "verifier", repeat, fixtureId: "G1", verdict: "accept", preGateVerdict: "accept" },
    ]);
    const s = scoreBench(manifest, { runs, expectedRuns: 4 });
    const hash = sha(block);
    const rec = benchRecordDraft(s, { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: hash });
    expect(rec.evidence).toContainEqual({ kind: "file_line", ref: ".claude/workflows/loop-iteration.js", result: `<loop-verifier> sha256=${hash}` });
    expect(rec.evidence[0].kind).toBe("measurement");
    expect(writeRecords([rec], ctx())[0].stored).toBe(true);
    expect(l3Check(replay(loadEntries(store), schema, POLICY), hash)).toMatchObject({ ok: true, unmet: [], verdict: "accept", repeats: 2, recordHash: hash });
    // Without a hash (the block could not be read) the draft names no verifier, so l3-check never passes it.
    expect(benchRecordDraft(s, { resultsRef: "r.json" }).evidence.map((e) => e.kind)).toEqual(["measurement"]);
  });
});

describe("l3Check: the L3 measured-checker item, computed from the LATEST bench record", () => {
  const HASH = "b".repeat(64);
  // The verifier arm measured the whole (2 bad / 2 good) manifest, as a passing record must show.
  const FULL = { bad: 2, good: 2 };
  const bench = ({ status = "accept", repeats = 2, gates = ["F2 (informational)"], hash = HASH, ...over } = {}) => ({
    writer_id: "trace-bench/score",
    claim_id: "bench:trace-bench-lite",
    claim_text: `TRACE-Bench-lite (2 bad / 2 good fixtures): ${status} at ${repeats} repeat(s), flags ${gates.join(", ") || "none"}`,
    claim_type: "measured",
    evidence: [
      { kind: "measurement", ref: "pnpm trace bench-score r.json [runs 0a1b2c3d]", result: JSON.stringify({ fixtures: FULL, arms: { verifier: { repeats, measured: FULL } } }) },
      ...(hash ? [{ kind: "file_line", ref: VERIFIER_FILE, result: `<loop-verifier> sha256=${hash}` }] : []),
    ],
    failed_gates: gates,
    missing: [],
    final_status: status,
    ...(status === "qualify" ? { qualifier: "measured on the clean runs only — 1 contaminated run(s) were excluded" } : {}),
    reason: "deterministic scoring of the raw bench runs",
    provenance: { workflow: "trace-bench" },
    ...over,
  });
  const checked = (draft, current = HASH) => {
    expect(writeRecords([draft], ctx())[0].stored).toBe(true);
    return l3Check(replay(loadEntries(store), schema, POLICY), current);
  };

  it("is met by an accept from repeat ≥ 2 that measured the current block (F1 and F2 do not hold it)", () => {
    const res = checked(bench({ gates: ["F2 (informational)", "F1 decomposition"] }));
    expect(res).toMatchObject({ ok: true, unmet: [], verdict: "accept", repeats: 2, recordHash: HASH, currentHash: HASH });
    expect(res.record_id).toMatch(/^TR-[0-9a-f]{12}$/);
  });

  it("is not met once the verifier changed after the bench (hash mismatch)", () => {
    const res = checked(bench(), "c".repeat(64));
    expect(res.ok).toBe(false);
    expect(res.unmet).toHaveLength(1);
    expect(res.unmet[0]).toMatch(/another <loop-verifier> block/);
  });

  it.each([
    ["a qualify", { status: "qualify" }, /qualify, not accept/],
    ["a single repeat", { repeats: 1 }, /1 repeat\(s\) — needs repeat ≥ 2/],
    ["an F3", { gates: ["F2 (informational)", "F3 instability"] }, /F3 instability/],
    ["an F0", { gates: ["F0 coverage"] }, /F0 coverage/],
    ["an F4", { gates: ["F4 wrong-accept"] }, /F4 wrong-accept/],
    ["a record with no hash (scored before L3 freshness)", { hash: null }, /no <loop-verifier> hash/],
    ["a measurement whose repeat count does not parse", { evidence: [{ kind: "measurement", ref: "pnpm trace bench-score r.json", result: '{"arms":{"verif' }, { kind: "file_line", ref: VERIFIER_FILE, result: `<loop-verifier> sha256=${HASH}` }] }, /repeat count/],
  ])("is not met by %s, and names exactly that condition", (_what, over, re) => {
    const res = checked(bench(over));
    expect(res.ok).toBe(false);
    expect(res.unmet).toHaveLength(1);
    expect(res.unmet[0]).toMatch(re);
  });

  it("reads the latest bench record, licensing or not: an older accept never stands in for a newer qualify", () => {
    const [first] = writeRecords([bench()], ctx());
    const [second] = writeRecords([bench({ status: "qualify", revises: first.record_id })], { ...ctx(), now: "2026-10-08T12:00:00.000Z" });
    expect(second.stored).toBe(true);
    const res = l3Check(replay(loadEntries(store), schema, POLICY), HASH);
    expect(res.record_id).toBe(second.record_id);
    expect(res.unmet).toEqual([expect.stringMatching(/qualify, not accept/)]);
  });

  it("lists every unmet condition at once, and fails closed without a record, a readable current block or a store that replays", () => {
    const all = checked(bench({ status: "qualify", repeats: 1, gates: ["F3 instability"], hash: "d".repeat(64) }));
    expect(all.ok).toBe(false);
    expect(all.unmet).toHaveLength(4);
    const unreadable = l3Check(replay(loadEntries(store), schema, POLICY), null);
    expect(unreadable.ok).toBe(false);
    expect(unreadable.unmet.some((u) => /current <loop-verifier> block .* cannot be read/.test(u))).toBe(true);
    expect(l3Check(replay([], schema, POLICY), HASH)).toMatchObject({ ok: false, record_id: null, unmet: [expect.stringMatching(/no bench:trace-bench-lite record/)] });
    const broken = l3Check(replay(parseLines("{not json\n", "records.jsonl"), schema, POLICY), HASH);
    expect(broken.ok).toBe(false);
    expect(broken.unmet.some((u) => /does not replay/.test(u))).toBe(true);
  });
});

// L3 needs a full verifier bench: a run over part of the manifest (bench-args --only) measured less
// than the manifest counts say, so each scored arm carries the fixtures it measured, the record
// states both, and l3Check needs the verifier arm over every fixture. A run without a verifier arm
// names no verifier. Synthetic manifests and runs only — never real fixture ids or patches.
describe("L3 needs a full verifier bench: measured fixture counts", () => {
  const HASH = "e".repeat(64);
  const manifest = { fixtures: [{ id: "B1", kind: "bad" }, { id: "B2", kind: "bad" }, { id: "G1", kind: "good" }, { id: "G2", kind: "good" }] };
  // Verifier runs on `ids` at `repeats` (default 0 and 1): bad diffs held, good ones licensed — no F0, F3 or F4.
  const verifierRuns = (ids, repeats = [0, 1]) =>
    repeats.flatMap((repeat) =>
      ids.map((id) => {
        const verdict = manifest.fixtures.find((f) => f.id === id).kind === "bad" ? "reject" : "accept";
        return { arm: "verifier", repeat, fixtureId: id, verdict, preGateVerdict: verdict };
      }),
    );
  const scored = (ids) => scoreBench(manifest, { runs: verifierRuns(ids), expectedRuns: ids.length * 2 });
  const l3 = (draft) => {
    expect(writeRecords([draft], ctx())[0].stored).toBe(true);
    return l3Check(replay(loadEntries(store), schema, POLICY), HASH);
  };

  it("scoreBench: each scored arm carries the manifest fixtures it measured — distinct ids among its scored runs", () => {
    const runs = [
      ...verifierRuns(["G1", "G2"]),
      { arm: "verifier", repeat: 0, fixtureId: "B1", verdict: "defer", noVerdict: true }, // excluded: it measured nothing
      { arm: "verifier", repeat: 0, fixtureId: "X9", verdict: "reject" }, // not a manifest fixture
      { arm: "single-pass", fixtureId: "B1", block: true },
      { arm: "single-pass", fixtureId: "G1", block: false },
      { arm: "panel", critic: "a", fixtureId: "B1", block: true },
      { arm: "panel", critic: "a", fixtureId: "B2", block: false },
      { arm: "panel", critic: "b", fixtureId: "B1", block: true },
    ];
    const s = scoreBench(manifest, { runs });
    expect(s.fixtures).toEqual({ bad: 2, good: 2 });
    expect(s.arms.verifier.measured).toEqual({ bad: 0, good: 2 });
    expect(s.arms.singlePass.measured).toEqual({ bad: 1, good: 1 });
    expect(s.arms.panel.measured).toEqual({ bad: 2, good: 0 });
  });

  it.each([
    ["only the good fixtures (bench-args --only)", ["G1", "G2"], /measured 0\/2 bad and 2\/2 good manifest fixtures/],
    ["all but one bad fixture", ["B1", "G1", "G2"], /measured 1\/2 bad and 2\/2 good manifest fixtures/],
    ["all but one good fixture", ["B1", "B2", "G1"], /measured 2\/2 bad and 1\/2 good manifest fixtures/],
  ])("l3Check is unmet when the verifier arm benched %s at repeat 2 with no F0, F3 or F4 — exactly the full-manifest condition", (_what, ids, re) => {
    const s = scored(ids);
    expect(s.arms.verifier.repeats).toBe(2);
    expect(s.flags.filter((f) => /^F[034]/.test(f))).toEqual([]);
    const res = l3(benchRecordDraft(s, { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: HASH }));
    expect(res.ok).toBe(false);
    expect(res.unmet).toHaveLength(1);
    expect(res.unmet[0]).toMatch(re);
    expect(res.unmet[0]).toMatch(/re-bench the full manifest/);
  });

  it("the same bench with every manifest fixture measured meets l3Check", () => {
    const s = scored(["B1", "B2", "G1", "G2"]);
    expect(s.arms.verifier.measured).toEqual({ bad: 2, good: 2 });
    const res = l3(benchRecordDraft(s, { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: HASH }));
    expect(res).toMatchObject({ ok: true, unmet: [], verdict: "accept", repeats: 2, recordHash: HASH });
  });

  it.each([
    ["a record scored before the counts (no fixtures, no measured)", { arms: { verifier: { repeats: 2 } } }],
    ["manifest counts without the verifier arm's measured counts", { fixtures: { bad: 2, good: 2 }, arms: { verifier: { repeats: 2 } } }],
    ["measured counts without the manifest's", { arms: { verifier: { repeats: 2, measured: { bad: 2, good: 2 } } } }],
    ["counts that are not integers", { fixtures: { bad: "2", good: 2 }, arms: { verifier: { repeats: 2, measured: { bad: "2", good: 2 } } } }],
    ["a manifest with no bad fixture (a verifier that never saw a bad diff)", { fixtures: { bad: 0, good: 2 }, arms: { verifier: { repeats: 2, measured: { bad: 0, good: 2 } } } }],
  ])("l3Check fails closed on %s, saying to re-bench the full manifest", (_what, metrics) => {
    const draft = benchRecordDraft(scored(["B1", "B2", "G1", "G2"]), { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: HASH });
    draft.evidence = draft.evidence.map((e) => (e.kind === "measurement" ? { ...e, result: JSON.stringify(metrics) } : e));
    const res = l3(draft);
    expect(res.ok).toBe(false);
    expect(res.unmet).toHaveLength(1);
    expect(res.unmet[0]).toMatch(/re-bench the full manifest/);
  });

  it("benchRecordDraft names a <loop-verifier> block only when the score has a verifier arm, and states each arm's measured counts next to the manifest's", () => {
    const named = (rec) => rec.evidence.some((e) => e.kind === "file_line" && e.ref === VERIFIER_FILE);
    // Single-pass only: no verifier was measured, so the hash it is handed names none.
    const single = scoreBench(manifest, { runs: manifest.fixtures.map((f) => ({ arm: "single-pass", fixtureId: f.id, block: f.kind === "bad" })) });
    expect(single.arms.verifier).toBeUndefined();
    const noVerifier = benchRecordDraft(single, { resultsRef: "r.json", verifierHash: HASH });
    expect(named(noVerifier)).toBe(false);
    expect(noVerifier.evidence.map((e) => e.kind)).toEqual(["measurement"]);
    expect(noVerifier.claim_text).toMatch(/manifest: 2 bad \/ 2 good fixtures/);
    expect(noVerifier.claim_text).toMatch(/verifier measured 0\/2 bad and 0\/2 good fixtures/);
    expect(noVerifier.claim_text).toMatch(/single-pass measured 2\/2 bad and 2\/2 good fixtures/);
    // With a verifier arm (over part of the manifest): the hash is named, and the counts show the gap.
    const partial = benchRecordDraft(scored(["G1", "G2"]), { resultsRef: "r.json", verifierHash: HASH });
    expect(partial.evidence).toContainEqual({ kind: "file_line", ref: VERIFIER_FILE, result: `<loop-verifier> sha256=${HASH}` });
    expect(partial.claim_text).toMatch(/verifier measured 0\/2 bad and 2\/2 good fixtures/);
    // The measurement item carries the manifest counts beside the arms (what l3Check reads).
    const metrics = JSON.parse(partial.evidence.find((e) => e.kind === "measurement").result);
    expect(metrics.fixtures).toEqual({ bad: 2, good: 2 });
    expect(metrics.arms.verifier.measured).toEqual({ bad: 0, good: 2 });
  });

  // L3 counts only the fixtures the verifier measured in EVERY repeat: bench-score concatenates
  // results files, so a part-manifest run (bench-args --only) at repeat 2 scored together with a
  // full-manifest run at repeat 1 has two repeat indices and touches every fixture, yet each bad
  // fixture was measured once — F3 (procedural invariance) could never fire for it.
  describe("only the fixtures measured in every repeat count", () => {
    // The good fixtures at repeats 0 and 1, plus the whole manifest at repeat 0 (two results files).
    const mixedRuns = () => [...verifierRuns(["G1", "G2"]), ...verifierRuns(["B1", "B2", "G1", "G2"], [0])];
    const counts = (s) => s.arms.verifier.perRepeat.map((p) => [p.repeat, p.measured]);

    it("scoreBench: the verifier arm's measured counts are the fixtures measured in every repeat index present, and each perRepeat entry carries its own", () => {
      const mixed = scoreBench(manifest, { runs: mixedRuns() });
      expect(mixed.arms.verifier.repeats).toBe(2);
      expect(mixed.flags.filter((f) => /^F[034]/.test(f))).toEqual([]);
      expect(mixed.arms.verifier.measured).toEqual({ bad: 0, good: 2 });
      expect(counts(mixed)).toEqual([[0, { bad: 2, good: 2 }], [1, { bad: 0, good: 2 }]]);
      // Every fixture at repeats 0 and 1: the counts equal the manifest's, in each repeat too.
      const full = scored(["B1", "B2", "G1", "G2"]);
      expect(full.arms.verifier.measured).toEqual({ bad: 2, good: 2 });
      expect(counts(full)).toEqual([[0, { bad: 2, good: 2 }], [1, { bad: 2, good: 2 }]]);
    });

    it("l3Check is unmet on that mixed bench (repeat 2, accept, no F0, F3 or F4) with the full-manifest message alone; the record shows where coverage fell short", () => {
      const draft = benchRecordDraft(scoreBench(manifest, { runs: mixedRuns() }), { resultsRef: "part.json full.json", runIds: ["0a1b2c3d", "4e5f6a7b"], verifierHash: HASH });
      expect(draft.final_status).toBe("accept");
      expect(draft.claim_text).toMatch(/verifier measured 0\/2 bad and 2\/2 good fixtures in every repeat/);
      const metrics = JSON.parse(draft.evidence.find((e) => e.kind === "measurement").result);
      expect(metrics.arms.verifier.perRepeat.map((p) => p.measured)).toEqual([{ bad: 2, good: 2 }, { bad: 0, good: 2 }]);
      const res = l3(draft);
      expect(res.ok).toBe(false);
      expect(res.unmet).toHaveLength(1);
      expect(res.unmet[0]).toMatch(/measured 0\/2 bad and 2\/2 good manifest fixtures in every repeat/);
      expect(res.unmet[0]).toMatch(/L3 needs every fixture in every repeat/);
      expect(res.unmet[0]).toMatch(/re-bench the full manifest/);
    });

    it("the same manifest with every fixture at repeats 0 and 1 meets l3Check, and its claim says the counts hold in every repeat", () => {
      const draft = benchRecordDraft(scored(["B1", "B2", "G1", "G2"]), { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: HASH });
      expect(draft.claim_text).toMatch(/verifier measured 2\/2 bad and 2\/2 good fixtures in every repeat/);
      expect(l3(draft)).toMatchObject({ ok: true, unmet: [], verdict: "accept", repeats: 2, recordHash: HASH });
      // A run without a verifier arm had no repeats: its claim never says "in every repeat".
      const single = scoreBench(manifest, { runs: manifest.fixtures.map((f) => ({ arm: "single-pass", fixtureId: f.id, block: f.kind === "bad" })) });
      expect(benchRecordDraft(single, { resultsRef: "r.json" }).claim_text).not.toMatch(/in every repeat/);
    });

    it("l3Check's fail-closed message (a record without the counts) also asks for every fixture in every repeat", () => {
      const draft = benchRecordDraft(scored(["B1", "B2", "G1", "G2"]), { resultsRef: "r.json", runIds: ["0a1b2c3d"], verifierHash: HASH });
      draft.evidence = draft.evidence.map((e) => (e.kind === "measurement" ? { ...e, result: JSON.stringify({ arms: { verifier: { repeats: 2 } } }) } : e));
      const res = l3(draft);
      expect(res.unmet).toHaveLength(1);
      expect(res.unmet[0]).toMatch(/every fixture in every repeat: re-bench the full manifest/);
    });
  });
});
