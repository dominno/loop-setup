// Behavioral tests for the verdict-producing workflows: run the REAL script bodies with
// stubbed DSL hooks (agent/parallel/pipeline/…) and scripted agent replies, then check
// what each workflow decides and that every record draft it emits satisfies the schema.
// Compile/parity checks alone cannot catch a deleted gate call or a broken reuse key.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { benchArgs, briefRecords, finalizeRecord, loadSchema, markUnscanned, opaqueFixtureId, readPolicyVersion, ROOT, scoreBench, semanticViolations, validate } from "./lib.mjs";

const schema = loadSchema();
const POLICY = readPolicyVersion();
const TREE = "0123456789abcdef";

async function runWorkflow(file, args, reply) {
  const text = readFileSync(join(ROOT, ".claude/workflows", file), "utf8").replace(/^export const meta =/m, "const meta =");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", text);
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label || "", prompt, opts });
    return reply(opts.label || "", prompt, opts);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        try {
          let r = item;
          for (const stage of stages) r = await stage(r, item, i);
          return r;
        } catch {
          return null;
        }
      }),
    );
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  const result = await fn(args, agent, parallel, pipeline, () => {}, () => {}, budget);
  return { result, calls };
}

/** Every record draft a workflow returns must be writable as-is (schema + semantic rules). */
function expectWritable(drafts) {
  for (const d of drafts) {
    const rec = finalizeRecord(d, { now: "2026-10-07T12:00:00.000Z", policyVersion: POLICY, commit: "abc1234def56" });
    const errs = [...validate(schema.$defs.record, rec, schema), ...semanticViolations(rec)];
    expect(errs, `${d.claim_id}: ${errs.join("; ")}`).toEqual([]);
  }
}

const finding = (over = {}) => ({
  severity: "blocker",
  claimType: "factual",
  title: "Input has no accessible name",
  evidence: "src/components/GreetingForm.tsx:58",
  recommendation: "restore htmlFor",
  ...over,
});
const verdict = (over = {}) => ({
  verdict: "accept",
  claimType: "factual",
  evidenceChecked: [{ kind: "file_line", ref: "src/components/GreetingForm.tsx:58" }],
  counterReasons: [],
  failedGates: [],
  missing: [],
  repair: "",
  qualifier: "",
  reason: "verified",
  ...over,
});
// Only the security critic reports (others return nothing) — keeps scenarios focused.
const onlySecurity = (findings) => (label) => (label.startsWith("critic:security") ? { findings } : { findings: [] });

describe("critic-panel (real body, stub agents)", () => {
  it("a missing skeptic verdict defers the finding — never confirmed, never refuted", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding()])(label) : null,
    );
    expect(result.confirmed).toHaveLength(0);
    expect(result.refuted).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].missing.length).toBeGreaterThan(0);
    expectWritable(result.traceRecords);
  });

  it("re-typing cannot lower the bar: a measured claim re-typed to factual still needs a measurement", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding({ claimType: "measured" })])(label) : verdict({ claimType: "factual" }),
    );
    expect(result.confirmed).toHaveLength(0);
    expect(result.deferred[0].verdict).toBe("defer");
    expect(result.traceRecords[0].retyped_from).toBe("measured");
    expectWritable(result.traceRecords);
  });

  it("a self-demoted qualify on reading-only evidence does not license a factual claim", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label.startsWith("critic:")
        ? onlySecurity([finding()])(label)
        : verdict({ verdict: "qualify", qualifier: "probably", evidenceChecked: [{ kind: "reading", ref: "skimmed" }] }),
    );
    expect(result.confirmed).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
  });

  const prior = {
    record_id: "TR-aaaaaaaaaaaa",
    claim_id: "critic:security:input-has-no-accessible-name",
    claim_text: "Input has no accessible name",
    claim_type: "factual",
    final_status: "accept",
    missing: [],
    reason: "verified earlier",
    provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE },
  };

  it("reuses a prior verdict only for the SAME claim on an identical tree (no skeptic call)", async () => {
    const { result, calls } = await runWorkflow(
      "critic-panel.js",
      { focus: "x", uiInScope: false, priorRecords: [prior], treeId: TREE },
      onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })]),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(0);
    expect(result.reuseActions).toEqual([expect.objectContaining({ record_id: prior.record_id, action: "REUSE" })]);
    expect(result.traceRecords).toHaveLength(0);
  });

  it("drops a revisits link to a DIFFERENT claim: the finding is adjudicated fresh, with its own claim_id", async () => {
    const { result, calls } = await runWorkflow(
      "critic-panel.js",
      { focus: "x", uiInScope: false, priorRecords: [prior], treeId: TREE },
      (label) =>
        label.startsWith("critic:")
          ? onlySecurity([finding({ title: "GreetingForm exceeds 300 lines", revisits: prior.record_id, revisitReason: "still-present" })])(label)
          : verdict(),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
    expect(result.reuseActions).toHaveLength(0);
    expect(result.traceRecords[0].claim_id).toBe("critic:security:greetingform-exceeds-300-lines");
    expect(result.traceRecords[0].revises).toBeUndefined();
    expectWritable(result.traceRecords);
  });

  it("an identical claim on a CHANGED tree is re-verified and recorded as a revision", async () => {
    const { result, calls } = await runWorkflow(
      "critic-panel.js",
      { focus: "x", uiInScope: false, priorRecords: [prior], treeId: "fedcba9876543210" },
      (label) => (label.startsWith("critic:") ? onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })])(label) : verdict()),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
    expect(result.traceRecords[0]).toMatchObject({ claim_id: prior.claim_id, revises: prior.record_id, final_status: "accept" });
  });
});

describe("loop-iteration (real body, stub agents)", () => {
  const items = [{ id: "LP-001", description: "fix the label" }];
  const impl = (over = {}) => ({
    changedFiles: ["src/components/GreetingForm.tsx"],
    diff: "diff --git a/src/components/GreetingForm.tsx b/src/components/GreetingForm.tsx\n--- a/src/components/GreetingForm.tsx\n+++ b/src/components/GreetingForm.tsx\n@@ -1 +1 @@\n-a\n+b\n",
    checksPassed: true,
    notes: "",
    ...over,
  });

  it("escalates a diff that touches a denylisted path even when changedFiles under-reports it — the verifier never runs", async () => {
    const sneaky = impl({ diff: "diff --git a/.claude/loop.md b/.claude/loop.md\n--- a/.claude/loop.md\n+++ b/.claude/loop.md\n@@ -1 +1 @@\n-a\n+b\n" });
    const { result, calls } = await runWorkflow("loop-iteration.js", { items, treeId: TREE, level: "L2" }, (label) => (label.startsWith("impl:") ? sneaky : verdict({ claimType: undefined })));
    expect(calls.some((c) => c.label.startsWith("verify:"))).toBe(false);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].status).toBe("escalated-denylist");
    expect(result.escalate).toEqual(["LP-001"]);
    expectWritable(result.traceRecords);
  });

  it("a missing verifier verdict defers the item — never applied", async () => {
    const { result } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) => (label.startsWith("impl:") ? impl() : null));
    expect(result.applied).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expectWritable(result.traceRecords);
  });

  it("a qualify citing only reading evidence does not license applying the diff", async () => {
    const { result } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
      label.startsWith("impl:") ? impl() : verdict({ verdict: "qualify", qualifier: "looks fine", evidenceChecked: [{ kind: "reading", ref: "skimmed" }] }),
    );
    expect(result.applied).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
  });

  it("an accept that cites the real diff is applied and recorded", async () => {
    const { result } = await runWorkflow("loop-iteration.js", { items, treeId: TREE, level: "L2" }, (label) =>
      label.startsWith("impl:") ? impl() : verdict({ evidenceChecked: [{ kind: "diff", ref: "src/components/GreetingForm.tsx" }] }),
    );
    expect(result.applied).toHaveLength(1);
    expect(result.traceRecords[0]).toMatchObject({ claim_id: "loop:lp-001", final_status: "accept", provenance: { tree: TREE } });
    expectWritable(result.traceRecords);
  });
});

describe("loop-iteration fail-closed paths", () => {
  const items = [{ id: "LP-002", description: "x", priorRecordId: "TR-bbbbbbbbbbbb" }];
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  it("refuses to dispatch at L1, an unknown level, or an OMITTED level (fail closed)", async () => {
    for (const level of ["L1", "L9", undefined]) {
      const { result, calls } = await runWorkflow("loop-iteration.js", { items, level }, () => null);
      expect(result.error).toMatch(/may not dispatch/);
      expect(calls).toHaveLength(0);
    }
  });
  it("escalates a non-empty diff whose paths cannot be parsed", async () => {
    const { result, calls } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
      label.startsWith("impl:") ? { changedFiles: [], diff: "garbage that is not a git diff", checksPassed: true, notes: "" } : verdict(),
    );
    expect(calls.some((c) => c.label.startsWith("verify:"))).toBe(false);
    expect(result.rejected[0].status).toBe("escalated-denylist");
  });
  it("at L3 a qualify is held for a human, not applied (at L2 it is applied)", async () => {
    const q = (label) => (label.startsWith("impl:") ? { changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" } : verdict({ verdict: "qualify", qualifier: "caveat", evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }));
    const l3 = await runWorkflow("loop-iteration.js", { items, level: "L3" }, q);
    expect(l3.result.applied).toHaveLength(0);
    expect(l3.result.held).toHaveLength(1);
    expect(l3.result.escalate).toEqual(["LP-002"]);
    const l2 = await runWorkflow("loop-iteration.js", { items, level: "L2" }, q);
    expect(l2.result.applied).toHaveLength(1);
  });

  it("a rename-only patch into a denylisted path is caught by the gate", async () => {
    const rename = "diff --git a/docs/x.md b/docs/y.md\nsimilarity index 100%\nrename from docs/x.md\nrename to .claude/loop.md\n";
    const { result } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
      label.startsWith("impl:") ? { changedFiles: ["docs/x.md"], diff: rename, checksPassed: true, notes: "" } : verdict(),
    );
    expect(result.rejected[0].status).toBe("escalated-denylist");
  });

  it("a re-dispatched node's new record revises its previous one", async () => {
    const { result } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
      label.startsWith("impl:") ? { changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" } : verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }),
    );
    expect(result.traceRecords[0].revises).toBe("TR-bbbbbbbbbbbb");
  });
});

describe("critic-panel round integrity", () => {
  it("a critic that died is reported, not mistaken for 'no findings'", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) => (label.startsWith("critic:security") ? null : { findings: [] }));
    expect(result.failedReviewers).toEqual(["security"]);
  });
  it("a prior of a DIFFERENT claim type is not reused even with the same title", async () => {
    const prior = { record_id: "TR-dddddddddddd", claim_id: "critic:security:input-has-no-accessible-name", claim_type: "measured", claim_text: "x", final_status: "accept", missing: [], reason: "r", provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE } };
    const { calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, priorRecords: [prior], treeId: TREE }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })])(label) : verdict(),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
  });

  it("a prior defer is never reused — it is re-adjudicated", async () => {
    const prior = { record_id: "TR-cccccccccccc", claim_id: "critic:security:input-has-no-accessible-name", claim_type: "factual", claim_text: "x", final_status: "defer", missing: ["m"], reason: "r", provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE } };
    const { calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, priorRecords: [prior], treeId: TREE }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })])(label) : verdict(),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
  });
});

describe("improve-skills and scan-docs face the evidence gate too", () => {
  const meta = { severity: "important", file: "CLAUDE.md", title: "Gate weakened", evidence: "CLAUDE.md:1", proposedEdit: "restore it" };
  const skeptic = (over = {}) => ({ real: true, editSafe: true, saferEdit: "", missing: [], evidenceChecked: [], reason: "ok", ...over });

  it("improve-skills: real + safe without a cited rule is deferred, not apply-ready", async () => {
    const { result } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety") ? { findings: [meta] } : label.startsWith("meta:") ? { findings: [] } : skeptic(),
    );
    expect(result.applyReady).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expectWritable(result.traceRecords);
  });

  it("improve-skills: real but NOT edit-safe is needsDesign (revise) with a safer edit as repair", async () => {
    const { result } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety")
        ? { findings: [meta] }
        : label.startsWith("meta:")
          ? { findings: [] }
          : skeptic({ editSafe: false, saferEdit: "narrower edit", evidenceChecked: [{ kind: "rule", ref: "CLAUDE.md rule" }] }),
    );
    expect(result.applyReady).toHaveLength(0);
    expect(result.needsDesign).toHaveLength(1);
    expect(result.needsDesign[0].repair).toBe("narrower edit");
    expectWritable(result.traceRecords);
  });

  it("improve-skills: real + safe with a cited rule is apply-ready; a null verdict is deferred, not refuted", async () => {
    const withRule = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety")
        ? { findings: [meta] }
        : label.startsWith("meta:")
          ? { findings: [] }
          : skeptic({ evidenceChecked: [{ kind: "rule", ref: "CLAUDE.md: never weaken a gate" }, { kind: "file_line", ref: "CLAUDE.md:1" }] }),
    );
    expect(withRule.result.applyReady).toHaveLength(1);
    expectWritable(withRule.result.traceRecords);
    const dead = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety") ? { findings: [meta] } : label.startsWith("meta:") ? { findings: [] } : null,
    );
    expect(dead.result.refuted).toHaveLength(0);
    expect(dead.result.deferred).toHaveLength(1);
  });

  it("scan-docs: a status verdict with no checked evidence is deferred and the status capped", async () => {
    const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
    const { result } = await runWorkflow("scan-docs.js", { stories: [story] }, (label) =>
      label.startsWith("evidence:")
        ? { implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Present", proposedStatus: "E2E tested", notes: "" }
        : { finalStatus: "E2E tested", justification: "trust me", missing: [], evidenceChecked: [] },
    );
    expect(result.records[0].verdict).toBe("defer");
    expect(result.records[0].finalStatus).toBe("Implemented");
    expectWritable(result.traceRecords);
  });
});

describe("trace-bench (real body, stub agents)", () => {
  it("marks a verifier run with no verdict as noVerdict (excluded by scoring, never a catch)", async () => {
    const fixtures = [{ id: "fx-00000000", item: "do a thing", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" }];
    const { result } = await runWorkflow("trace-bench.js", { fixtures, arms: ["verifier"], repeat: 1 }, () => null);
    expect(result.runs).toEqual([expect.objectContaining({ arm: "verifier", noVerdict: true, verdict: "defer" })]);
  });
});

describe("round-3 fixes (real bodies, stub agents)", () => {
  it("a qualify reused from `pnpm trace query --brief` output keeps its qualifier", async () => {
    const stored = {
      record_id: "TR-cccccccccccc", claim_id: "critic:security:input-has-no-accessible-name", claim_text: "Input has no accessible name",
      claim_type: "factual", final_status: "qualify", qualifier: "only on the mobile layout", repair: "", failed_gates: ["g"], missing: [],
      reason: "verified earlier", provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE }, created_at: "2026-10-07T12:00:00.000Z",
    };
    const { result, calls } = await runWorkflow(
      "critic-panel.js",
      { focus: "x", uiInScope: false, priorRecords: briefRecords([stored]), treeId: TREE },
      onlySecurity([finding({ revisits: stored.record_id, revisitReason: "still-present" })]),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(0);
    expect(result.confirmed[0]).toMatchObject({ verdict: "qualify", qualifier: "only on the mobile layout", failedGates: ["g"], reused: stored.record_id });
  });

  const items = [{ id: "LP-003", description: "x" }];
  const gate = (diff) => runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
    label.startsWith("impl:") ? { changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" } : verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }),
  );
  const ok = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n--- a removed comment line\n+b\n ctx\n";

  it("a mixed-format patch (a second section with a non-a/b prefix) is unparsable and escalated", async () => {
    const { result, calls } = await gate(`${ok}--- c/.claude/memory/loop-plan.md\n+++ c/.claude/memory/loop-plan.md\n@@ -1 +1 @@\n-a\n+b\n`);
    expect(calls.some((c) => c.label.startsWith("verify:"))).toBe(false);
    expect(result.rejected[0]).toMatchObject({ status: "escalated-denylist", failedGates: ["denylist:unparsable-diff-paths"] });
  });

  it("a traditional section with a tab timestamp is parsed (so a .env it creates is a denylist hit)", async () => {
    const { result } = await gate(`${ok}--- /dev/null\t2026-01-01 00:00:00\n+++ b/.env.local\t2026-01-01 00:00:00\n@@ -0,0 +1 @@\n+K=1\n`);
    expect(result.rejected[0].status).toBe("escalated-denylist");
    expect(result.rejected[0].failedGates[0]).toMatch(/\.env\.local/);
  });

  it("hunk content that looks like a header ('--- …' removed text) is not mistaken for one", async () => {
    const { result } = await gate(ok);
    expect(result.applied).toHaveLength(1);
  });

  it("trace-bench runs and agent labels (every arm, run id included) match what the scorer and the F0 coverage scan expect", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const manifest = { fixtures: [{ id: "B90-x", kind: "bad", item: "x", patch }, { id: "G90-y", kind: "good", item: "y", patch }] };
    const args = benchArgs(manifest, { arms: ["verifier", "single-pass", "panel"], repeat: 2, critics: ["qa-e2e", "security"], runId: "0a1b2c3d" });
    const { result, calls } = await runWorkflow("trace-bench.js", args, (label) =>
      label.startsWith("bench-verify:") ? verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }) : { block: label.includes(opaqueFixtureId("B90-x")), findings: [] },
    );
    expect(result.runId).toBe("0a1b2c3d");
    const runs = markUnscanned(result.runs.map((r) => ({ ...r, runId: result.runId })), calls.map((c) => ({ label: c.label, text: "scanned" })));
    const score = scoreBench(manifest, { runs });
    expect(score.unscannedRuns).toBe(0);
    expect(score.arms.verifier).toMatchObject({ wrongAcceptRate: 1, falseHoldRate: 0 });
    expect(score.arms.verifier.perRepeat).toHaveLength(2);
    expect(score.arms.singlePass).toMatchObject({ agents: 2, recall: 1, falseBlockRate: 0 });
    expect(score.arms.panel).toMatchObject({ critics: 2, agents: 4 });
  });
});
