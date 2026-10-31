// Behavioral tests for the verdict-producing workflows: run the REAL script bodies with
// stubbed DSL hooks (agent/parallel/pipeline/…) and scripted agent replies, then check
// what each workflow decides and that every record draft it emits satisfies the schema.
// Compile/parity checks alone cannot catch a deleted gate call or a broken reuse key.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { benchArgs, briefRecords, finalizeRecord, loadSchema, loadWorkflowBlock, markUnscanned, opaqueFixtureId, readPolicyVersion, ROOT, scoreBench, semanticViolations, validate } from "./lib.mjs";

const schema = loadSchema();
const POLICY = readPolicyVersion();
const TREE = "0123456789abcdef";
// The budget of a turn with no '+Nk' token target: total is null, so no budget floor fires.
const UNLIMITED = { total: null, spent: () => 0, remaining: () => Infinity };

async function runWorkflow(file, args, reply, budget = UNLIMITED) {
  const text = readFileSync(join(ROOT, ".claude/workflows", file), "utf8").replace(/^export const meta =/m, "const meta =");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", text);
  const calls = [];
  // A reply that throws becomes a rejected promise, the path each call site's .catch handles. An
  // error tagged `sync` (throwingSync) is thrown before agent() returns instead, so that .catch is
  // never reached and parallel()/pipeline() must turn the thunk or stage into a null slot.
  const agent = (prompt, opts = {}) => {
    calls.push({ label: opts.label || "", prompt, opts });
    try {
      return Promise.resolve(reply(opts.label || "", prompt, opts));
    } catch (e) {
      if (e && e.sync) throw e;
      return Promise.reject(e);
    }
  };
  // Each log line, with the number of agent calls made before it was written.
  const logs = [];
  const log = (m) => logs.push({ text: String(m), calls: calls.length });
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
  const result = await fn(args, agent, parallel, pipeline, () => {}, log, budget);
  return { result, calls, logs };
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
// agent() THROWS for every label with this prefix (as the real one does once the token budget
// is spent, or on a harness error); every other label gets `reply`.
const throwing = (prefix, reply) => (label, ...rest) => {
  if (label.startsWith(prefix)) throw new Error(`agent died: ${label}`);
  return reply(label, ...rest);
};
// agent() itself throws SYNCHRONOUSLY (before returning a promise) for every label with this
// prefix, so the call site's .catch is never reached: the parallel() slot becomes null.
const throwingSync = (prefix, reply) => (label, ...rest) => {
  if (label.startsWith(prefix)) throw Object.assign(new Error(`agent died synchronously: ${label}`), { sync: true });
  return reply(label, ...rest);
};

describe("critic-panel (real body, stub agents)", () => {
  it("a missing skeptic verdict defers the finding — never confirmed, never refuted", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding()])(label) : null,
    );
    expect(result.confirmed).toHaveLength(0);
    expect(result.refuted).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].missing.length).toBeGreaterThan(0);
    expectWritable(result.traceRecords);
  });

  it("re-typing cannot lower the bar: a measured claim re-typed to factual still needs a measurement", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding({ claimType: "measured" })])(label) : verdict({ claimType: "factual" }),
    );
    expect(result.confirmed).toHaveLength(0);
    expect(result.deferred[0].verdict).toBe("defer");
    expect(result.traceRecords[0].retyped_from).toBe("measured");
    expectWritable(result.traceRecords);
  });

  it("a self-demoted qualify on reading-only evidence does not license a factual claim", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, (label) =>
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
      { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: [prior], treeId: TREE },
      onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })]),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(0);
    expect(result.reuseActions).toEqual([expect.objectContaining({ record_id: prior.record_id, action: "REUSE" })]);
    expect(result.traceRecords).toHaveLength(0);
  });

  it("drops a revisits link to a DIFFERENT claim: the finding is adjudicated fresh, with its own claim_id", async () => {
    const { result, calls } = await runWorkflow(
      "critic-panel.js",
      { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: [prior], treeId: TREE },
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
      { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: [prior], treeId: "fedcba9876543210" },
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
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, (label) => (label.startsWith("critic:security") ? null : { findings: [] }));
    expect(result.failedReviewers).toEqual(["security"]);
  });
  it("a prior of a DIFFERENT claim type is not reused even with the same title", async () => {
    const prior = { record_id: "TR-dddddddddddd", claim_id: "critic:security:input-has-no-accessible-name", claim_type: "measured", claim_text: "x", final_status: "accept", missing: [], reason: "r", provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE } };
    const { calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: [prior], treeId: TREE }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding({ revisits: prior.record_id, revisitReason: "still-present" })])(label) : verdict(),
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
  });

  it("a prior defer is never reused — it is re-adjudicated", async () => {
    const prior = { record_id: "TR-cccccccccccc", claim_id: "critic:security:input-has-no-accessible-name", claim_type: "factual", claim_text: "x", final_status: "defer", missing: ["m"], reason: "r", provenance: { commit: "abc1234", workflow: "critic-panel", tree: TREE } };
    const { calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: [prior], treeId: TREE }, (label) =>
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

  it("improve-skills: a finding the skeptic refutes (real:false) is rejected, never apply-ready", async () => {
    const { result } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety")
        ? { findings: [meta] }
        : label.startsWith("meta:")
          ? { findings: [] }
          : skeptic({ real: false, evidenceChecked: [{ kind: "rule", ref: "CLAUDE.md rule" }, { kind: "file_line", ref: "CLAUDE.md:1" }] }),
    );
    expect(result.applyReady).toHaveLength(0);
    expect(result.refuted).toHaveLength(1);
    expect(result.traceRecords[0].final_status).toBe("reject");
  });

  const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
  const evidenceAt = (proposedStatus) => ({ implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Present", proposedStatus, notes: "" });
  const checked = [{ kind: "file_line", ref: "src/lib/greeting.ts:1" }, { kind: "command", ref: "pnpm test", result: "pass" }];

  it("scan-docs: a verifier that DOWNGRADES the status is a qualify (holds only at the lower status), not an accept", async () => {
    const { result } = await runWorkflow("scan-docs.js", { stories: [story] }, (label) =>
      label.startsWith("evidence:") ? evidenceAt("E2E tested") : { finalStatus: "Unit tested", justification: "no e2e", missing: [], evidenceChecked: checked },
    );
    expect(result.records[0]).toMatchObject({ verdict: "qualify", finalStatus: "Unit tested" });
    expectWritable(result.traceRecords);
  });

  it("scan-docs: a verifier that UPGRADES the status is a revise (the maker's claim was wrong), not an accept", async () => {
    const { result } = await runWorkflow("scan-docs.js", { stories: [story] }, (label) =>
      label.startsWith("evidence:") ? evidenceAt("Implemented") : { finalStatus: "E2E tested", justification: "e2e exists", missing: [], evidenceChecked: checked },
    );
    expect(result.records[0].verdict).toBe("revise");
    expectWritable(result.traceRecords);
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
      { focus: "x", uiInScope: false, reviewMode: "panel", priorRecords: briefRecords([stored]), treeId: TREE },
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

  it("a rename whose header quotes only one side (a non-ASCII name) is parsed, not escalated", async () => {
    const { result } = await gate('diff --git a/src/a.ts "b/src/\\303\\251.ts"\nsimilarity index 100%\nrename from src/a.ts\nrename to "src/\\303\\251.ts"\n');
    expect(result.applied).toHaveLength(1);
  });

  it("a copy into a protected path, and a rename OUT of one behind a harmless header, are escalated", async () => {
    const copy = await gate("diff --git a/src/a.ts b/.github/workflows/ci.yml\nsimilarity index 100%\ncopy from src/a.ts\ncopy to .github/workflows/ci.yml\n");
    expect(copy.result.rejected[0].status).toBe("escalated-denylist");
    const away = await gate("diff --git a/src/a.ts b/src/lib.bak\nsimilarity index 100%\nrename from scripts/trace/lib.mjs\nrename to src/lib.bak\n");
    expect(away.result.rejected[0].status).toBe("escalated-denylist");
  });

  it("hunk content that looks like a header ('--- …' removed text) is not mistaken for one", async () => {
    const { result } = await gate(ok);
    expect(result.applied).toHaveLength(1);
  });

  it("trace-bench runs and agent labels (every arm, run id included) match what the scorer and the F0 coverage scan expect", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const ci = "diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\n--- a/.github/workflows/x.yml\n+++ b/.github/workflows/x.yml\n@@ -1 +1 @@\n-a\n+b\n";
    const manifest = { fixtures: [{ id: "B90-x", kind: "bad", item: "x", patch }, { id: "B91-ci", kind: "bad", item: "z", patch: ci }, { id: "G90-y", kind: "good", item: "y", patch }] };
    const args = benchArgs(manifest, { arms: ["verifier", "single-pass", "panel"], repeat: 2, critics: ["qa-e2e", "security"], runId: "0a1b2c3d" });
    const { result, calls } = await runWorkflow("trace-bench.js", args, (label) =>
      label.startsWith("bench-verify:") ? verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }) : { block: !label.includes(opaqueFixtureId("G90-y")), findings: [] },
    );
    expect(result.runId).toBe("0a1b2c3d");
    const runs = markUnscanned(result.runs.map((r) => ({ ...r, runId: result.runId })), calls.map((c) => ({ label: c.label, text: "scanned" })));
    const score = scoreBench(manifest, { runs });
    expect(score.unscannedRuns).toBe(0);
    // The verifier accepts everything: the CI-config fixture is caught by the denylist hit the
    // run carries (denylistHit), the other bad one is a wrong accept.
    expect(score.arms.verifier).toMatchObject({ wrongAcceptRate: 0.5, falseHoldRate: 0 });
    expect(score.arms.verifier.perRepeat).toHaveLength(2);
    expect(score.arms.singlePass).toMatchObject({ agents: 3, recall: 1, falseBlockRate: 0 });
    expect(score.arms.panel).toMatchObject({ critics: 2, agents: 6 });
  });
});

describe("critic-panel review modes (F1: single-pass on code-only rounds)", () => {
  it("a code-only round (uiInScope: false) uses ONE all-lens reviewer; its findings keep their lens and each still gets a separate skeptic", async () => {
    const { result, calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label === "critic:all-lenses-0" ? { findings: [finding({ lens: "security" }), finding({ lens: "regression", title: "Route changed", severity: "important" })] } : verdict({ evidenceChecked: [{ kind: "file_line", ref: "src/a.ts:1" }] }),
    );
    expect(result.reviewMode).toBe("single-pass");
    expect(calls.filter((c) => c.label.startsWith("critic:"))).toHaveLength(1);
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(2);
    expect(result.confirmed.map((f) => f.critic).sort()).toEqual(["regression", "security"]);
    expect(result.confirmed[0].lens).toBeUndefined();
    expect(result.traceRecords.map((r) => r.claim_id).sort()).toEqual(["critic:regression:route-changed", "critic:security:input-has-no-accessible-name"]);
    expectWritable(result.traceRecords);
  });

  it("a dead single reviewer leaves every lens unreviewed — reported, never a clean pass", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, () => null);
    expect(result.failedReviewers.length).toBe(result.counts.critics);
    expect(result.confirmed).toHaveLength(0);
  });

  it("single-pass: a finding that re-raises a prior claim takes that claim's lens, so verdict reuse still fires", async () => {
    const prior = { record_id: "TR-dddddddddddd", claim_id: "critic:security:input-has-no-accessible-name", claim_text: "x", claim_type: "factual", final_status: "accept", missing: [], provenance: { tree: TREE } };
    const { result, calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, priorRecords: [prior], treeId: TREE }, (label) =>
      label === "critic:all-lenses-0" ? { findings: [finding({ lens: "regression", revisits: prior.record_id, revisitReason: "still-present" })] } : null,
    );
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(0);
    expect(result.reuseActions).toEqual([expect.objectContaining({ record_id: prior.record_id, action: "REUSE" })]);
    expect(result.confirmed[0].critic).toBe("security");
  });

  it("single-pass: a reviewer that throws is a failed reviewer (like the panel), not a crashed round", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) => {
      if (label === "critic:all-lenses-0") throw new Error("budget exhausted");
      return null;
    });
    expect(result.failedReviewers.length).toBe(result.counts.critics);
    expect(result.counts.reviewAgents).toBe(1);
  });

  it("single-pass: a finding with no in-scope lens is counted, not silently lost; cross-lens duplicates are not corroboration", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label === "critic:all-lenses-0"
        ? { findings: [finding({ lens: "designer" }), finding({ lens: "security", evidence: "a.ts:1" }), finding({ lens: "regression", evidence: "b.ts:2" })] }
        : verdict({ evidenceChecked: [{ kind: "file_line", ref: "a.ts:1" }] }),
    );
    expect(result.counts.unassignedFindings).toBe(1);
    expect(result.counts.independentlyCorroborated).toBe(0);
    // The dropped finding was never adjudicated, so completion names it. The merged
    // security/regression blocker is confirmed here, and a confirmed blocker (reject) outranks defer.
    expect(result.completion.verdict).toBe("reject");
    expect(result.completion.missing.join("\n")).toContain("Input has no accessible name");
    // A dropped finding alone leaves the round unsettled: defer, never accept.
    const alone = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false }, (label) =>
      label === "critic:all-lenses-0" ? { findings: [finding({ lens: "designer", title: "Focus ring is missing" })] } : null,
    );
    expect(alone.calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(0);
    expect(alone.result.counts.unassignedFindings).toBe(1);
    expect(alone.result.completion.verdict).toBe("defer");
    expect(alone.result.completion.missing.join("\n")).toContain("Focus ring is missing");
  });

  it("a round that drives the app keeps the panel (one critic per lens), and the mode can be forced", async () => {
    const ui = await runWorkflow("critic-panel.js", { focus: "x" }, () => ({ findings: [] }));
    expect(ui.result.reviewMode).toBe("panel");
    expect(ui.calls.filter((c) => c.label.startsWith("critic:"))).toHaveLength(10);
    const forced = await runWorkflow("critic-panel.js", { focus: "x", reviewMode: "single-pass" }, () => ({ findings: [] }));
    expect(forced.calls.filter((c) => c.label.startsWith("critic:"))).toHaveLength(1);
  });
});

describe("loop verifier prompt (F4)", () => {
  it("tells the verifier to hold an item that contradicts a documented contract for a human, never to license it", async () => {
    const items = [{ id: "LP-009", description: "x" }];
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { calls } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) =>
      label.startsWith("impl:") ? { changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" } : verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }),
    );
    const prompt = calls.find((c) => c.label.startsWith("verify:")).prompt;
    expect(prompt).toMatch(/DOCUMENTED CONTRACTS/);
    expect(prompt).toMatch(/a human decision to change/);
    expect(prompt).toMatch(/never accept or qualify because the diff "does what the item asks"/);
  });
});

// parallel() and pipeline() turn a throwing stage into a null slot, and the workflows filter
// null slots out — so before this, a checker or maker that THREW vanished from the result
// with no record. Each case below must instead take the workflow's own fail-safe null path.
describe("agent failures never vanish (a throwing agent takes the null path, marked agent-failed)", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

  it("critic-panel (panel): a critic that throws is named by its lens key in failedReviewers", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, throwing("critic:security", () => ({ findings: [] })));
    expect(result.failedReviewers).toEqual(["security"]);
  });

  it("critic-panel: a blocker whose skeptic throws is deferred with verdict-missing + agent-failed, never dropped", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, throwing("verify:", onlySecurity([finding()])));
    expect(result.counts.deferred).toBe(1);
    expect(result.deferred[0].failedGates).toEqual(["verdict-missing", "agent-failed"]);
    expect(result.traceRecords).toHaveLength(1);
    expect(result.traceRecords[0]).toMatchObject({ final_status: "defer", failed_gates: ["verdict-missing", "agent-failed"] });
    expectWritable(result.traceRecords);
  });

  const metaFinding = { severity: "important", file: "CLAUDE.md", title: "Gate weakened", evidence: "CLAUDE.md:1", proposedEdit: "restore it" };
  it("improve-skills: a lens that throws is named by its key; a finding whose skeptic throws is deferred (agent-failed)", async () => {
    const dead = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, throwing("meta:safety-gating", () => ({ findings: [] })));
    expect(dead.result.failedReviewers).toEqual(["safety-gating"]);
    const { result } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, throwing("verify:", (label) => (label.startsWith("meta:safety") ? { findings: [metaFinding] } : { findings: [] })));
    expect(result.counts.deferred).toBe(1);
    expect(result.refuted).toHaveLength(0);
    expect(result.deferred[0].failedGates).toEqual(["verdict-missing", "agent-failed"]);
    expect(result.traceRecords[0]).toMatchObject({ final_status: "defer", failed_gates: ["verdict-missing", "agent-failed"] });
    expectWritable(result.traceRecords);
  });

  const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
  const evidence = { implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Present", proposedStatus: "E2E tested", notes: "" };
  it("scan-docs: an evidence agent that throws keeps the story as one defer record (no-evidence-report + agent-failed)", async () => {
    // A second, healthy story keeps this a PARTIAL failure: when every evidence agent dies,
    // the whole scan is an error that writes no records (round integrity, tested below).
    const other = { id: "US-002", title: "Farewell", source: "docs/prd.md" };
    const verified = { finalStatus: "E2E tested", justification: "a spec covers it", missing: [], evidenceChecked: [{ kind: "file_line", ref: "e2e/greeting.spec.ts:1" }] };
    const live = (label) => (label.startsWith("evidence:") ? evidence : verified);
    for (const reply of [throwing("evidence:US-001", live), (label) => (label.startsWith("evidence:US-001") ? null : live(label))]) {
      const { result } = await runWorkflow("scan-docs.js", { stories: [story, other] }, reply);
      expect(result.error).toBeUndefined();
      expect(result.count).toBe(2);
      expect(result.records[0]).toMatchObject({ id: "US-001", verdict: "defer", finalStatus: null, failedGates: ["no-evidence-report", "agent-failed"] });
      expect(result.records[1]).toMatchObject({ id: "US-002", verdict: "accept", finalStatus: "E2E tested" });
      expect(result.traceRecords).toHaveLength(2);
      expect(result.traceRecords[0].missing).toEqual(["an evidence report for this story (the evidence agent returned nothing)"]);
      expectWritable(result.traceRecords);
    }
  });

  it("scan-docs: a status verifier that throws or returns nothing defers the story with a named missing, not the 'unspecified' fallback", async () => {
    const dies = throwing("verify:", () => evidence);
    const silent = (label) => (label.startsWith("evidence:") ? evidence : null);
    for (const reply of [dies, silent]) {
      const { result } = await runWorkflow("scan-docs.js", { stories: [story] }, reply);
      expect(result.error).toBeUndefined(); // a dead verifier is a per-story defer, never a whole-phase error
      expect(result.count).toBe(1);
      expect(result.traceRecords).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        verdict: "defer",
        finalStatus: "Implemented", // the fail-closed cap on the maker's self-proposed status
        failedGates: ["verdict-missing", "agent-failed"],
        missing: ["a status verdict from the verifier (none was returned)"],
      });
      expectWritable(result.traceRecords);
    }
  });

  it("loop-iteration: a dead implementer (threw, or returned nothing) is deferred as agent-failed for re-dispatch; a live empty diff stays 'no-diff'", async () => {
    // A second, healthy item keeps this a PARTIAL failure: when every implementer dies, the
    // whole iteration is an error that writes no records (round integrity, tested below).
    const items = [{ id: "LP-010", description: "x" }, { id: "LP-012", description: "y" }];
    const live = (label) => (label.startsWith("impl:") ? { changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" } : verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }));
    for (const reply of [throwing("impl:LP-010", live), (label) => (label.startsWith("impl:LP-010") ? null : live(label))]) {
      const { result, calls } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, reply);
      expect(result.error).toBeUndefined();
      expect(calls.some((c) => c.label.startsWith("verify:LP-010"))).toBe(false);
      expect(result.applied.map((o) => o.id)).toEqual(["LP-012"]);
      expect(result.escalate).toEqual([]);
      expect(result.deferred).toHaveLength(1);
      expect(result.deferred[0]).toMatchObject({
        id: "LP-010",
        status: "deferred",
        verdict: "defer",
        failedGates: ["agent-failed"],
        missing: ["a diff from the implementer (the implementer agent failed — re-dispatch)"],
      });
      expectWritable(result.traceRecords);
    }
    // One live implementer with an empty diff is not a dead one (never an error).
    const empty = await runWorkflow("loop-iteration.js", { items: [items[0]], level: "L2" }, (label) => (label.startsWith("impl:") ? { changedFiles: [], diff: "", checksPassed: true, notes: "" } : verdict()));
    expect(empty.result.error).toBeUndefined();
    expect(empty.result.deferred[0].failedGates).toEqual(["no-diff"]);
  });

  it("loop-iteration: a verifier that throws defers the item with verdict-missing + agent-failed — never applied, never dropped", async () => {
    const items = [{ id: "LP-011", description: "x" }];
    const { result } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, throwing("verify:", () => ({ changedFiles: ["src/a.ts"], diff, checksPassed: true, notes: "" })));
    expect(result.applied).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].failedGates).toEqual(["verdict-missing", "agent-failed"]);
    expect(result.traceRecords[0]).toMatchObject({ final_status: "defer", failed_gates: ["verdict-missing", "agent-failed"] });
    expectWritable(result.traceRecords);
  });

  it("trace-bench: a bench agent that throws is one noVerdict run, never a vanished one (every arm)", async () => {
    const fixtures = [{ id: "fx-00000001", item: "x", patch: diff }, { id: "fx-00000002", item: "y", patch: diff }];
    const ok = (label) => (label.startsWith("bench-verify:") ? verdict({ evidenceChecked: [{ kind: "diff", ref: "src/a.ts" }] }) : { block: false, findings: [], reason: "ok" });
    for (const [arm, prefix] of [["verifier", "bench-verify:fx-00000001"], ["single-pass", "bench-single:fx-00000001"], ["panel", "bench-panel:fx-00000001:security"]]) {
      const { result } = await runWorkflow("trace-bench.js", { fixtures, arms: [arm], repeat: 1, critics: ["security", "regression"] }, throwing(prefix, ok));
      expect(result.runs, arm).toHaveLength(result.agents);
      expect(result.runs.filter((r) => r.noVerdict), arm).toHaveLength(1);
    }
  });
});

// Round integrity: whether a critic round is complete and clean is computed in code
// (`completion`), never inferred by the caller from empty lists; and a phase in which every
// agent failed is an `error`, never an empty-but-clean result.
const CODE_LENSES = ["frontend-arch", "qa-e2e", "performance", "security", "regression"]; // in scope when uiInScope is false
const deadReplies = (prefix) => [() => null, throwing(prefix, () => null)]; // every agent returns nothing / every agent throws

describe("round integrity: critic-panel completion is computed in code", () => {
  const code = { focus: "x", uiInScope: false, reviewMode: "panel" };
  const clean = () => ({ findings: [] });
  // A prior blocker of the designer lens, which a code-only round (uiInScope: false) does not review.
  const designerBlocker = (over = {}) => ({
    record_id: "TR-eeeeeeeeeee1", claim_id: "critic:designer:button-spacing-is-off", claim_text: "Button spacing is off", claim_type: "factual",
    severity: "blocker", final_status: "accept", qualifier: "", repair: "", failed_gates: [], missing: [], reason: "verified earlier",
    provenance: { tree: TREE }, created_at: "2026-10-07T12:00:00.000Z", cleared: false, ...over,
  });

  it("a clean round is accept; an accepted IMPORTANT finding does not refute 'no open blocker'", async () => {
    const { result } = await runWorkflow("critic-panel.js", code, clean);
    expect(result.error).toBeUndefined();
    expect(result.completion).toEqual({ claim: "no open blocker in: x", verdict: "accept", missing: [], notRechecked: [] });
    const important = await runWorkflow("critic-panel.js", code, (label) => (label.startsWith("critic:") ? onlySecurity([finding({ severity: "important" })])(label) : verdict()));
    expect(important.result.confirmed).toHaveLength(1);
    expect(important.result.completion.verdict).toBe("accept");
  });

  it("an accepted blocker is reject", async () => {
    const { result } = await runWorkflow("critic-panel.js", code, (label) => (label.startsWith("critic:") ? onlySecurity([finding()])(label) : verdict()));
    expect(result.counts.confirmedBlockers).toBe(1);
    expect(result.completion.verdict).toBe("reject");
  });

  it("a blocker whose skeptic throws is defer, carrying that blocker's missing", async () => {
    const { result } = await runWorkflow("critic-panel.js", code, throwing("verify:", onlySecurity([finding()])));
    expect(result.deferred).toHaveLength(1);
    expect(result.completion.verdict).toBe("defer");
    const missing = result.completion.missing.join("\n");
    for (const m of result.deferred[0].missing) expect(missing).toContain(m);
    expect(missing).toContain(result.deferred[0].title);
  });

  it("a revised blocker is defer, carrying its repair", async () => {
    const { result } = await runWorkflow("critic-panel.js", code, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding()])(label) : verdict({ verdict: "revise", repair: "only the email input lacks a name" }),
    );
    expect(result.revised).toHaveLength(1);
    expect(result.completion.verdict).toBe("defer");
    expect(result.completion.missing.join("\n")).toContain("only the email input lacks a name");
  });

  it("a dead security lens with a prior security record is defer, and notRechecked names that record (not a reviewed lens's prior)", async () => {
    const sec = designerBlocker({ record_id: "TR-aaaaaaaaaaa1", claim_id: "critic:security:token-in-url", severity: "important" });
    const reg = designerBlocker({ record_id: "TR-aaaaaaaaaaa2", claim_id: "critic:regression:route-changed", severity: "important" });
    const { result } = await runWorkflow("critic-panel.js", { ...code, priorRecords: [sec, reg] }, (label) => (label.startsWith("critic:security") ? null : { findings: [] }));
    expect(result.failedReviewers).toEqual(["security"]);
    expect(result.error).toBeUndefined();
    expect(result.completion.verdict).toBe("defer");
    expect(result.completion.missing).toEqual(["a review through the security lens — its reviewer failed (infra)"]);
    expect(result.completion.notRechecked).toEqual([sec.record_id]);
  });

  it("an open prior blocker in a lens the round did not review (out of scope) keeps completion at defer, naming it", async () => {
    for (const final_status of ["accept", "qualify", "defer", "revise"]) {
      const prior = designerBlocker({ final_status });
      const { result } = await runWorkflow("critic-panel.js", { ...code, priorRecords: [prior] }, clean);
      expect(result.completion.verdict, final_status).toBe("defer");
      expect(result.completion.missing).toEqual([`re-review of the designer lens for open prior blocker ${prior.record_id} (or CLEAR it on verified evidence)`]);
      expect(result.completion.notRechecked).toEqual([prior.record_id]);
    }
  });

  it("a cleared, refuted, superseded or non-blocker prior of an unreviewed lens leaves completion accept, still listed in notRechecked", async () => {
    const newer = designerBlocker({ record_id: "TR-eeeeeeeeeee2", final_status: "reject", created_at: "2026-10-08T12:00:00.000Z" });
    const cases = [
      [designerBlocker({ cleared: true })],
      [designerBlocker({ severity: "nice-to-have" })],
      [designerBlocker({ final_status: "reject" })],
      [designerBlocker(), newer], // the accept is superseded by a newer record for the same claim
    ];
    for (const priors of cases) {
      const { result } = await runWorkflow("critic-panel.js", { ...code, priorRecords: priors }, clean);
      expect(result.completion.verdict).toBe("accept");
      expect(result.completion.notRechecked).toEqual(priors.map((p) => p.record_id));
    }
  });

  it("through `query --brief`: a stored prior blocker stays open until a CLEAR action names it", async () => {
    const stored = designerBlocker(); // briefRecords derives `cleared` from the actions, never from the record
    const open = await runWorkflow("critic-panel.js", { ...code, priorRecords: briefRecords([stored]) }, clean);
    expect(open.result.completion.verdict).toBe("defer");
    const cleared = await runWorkflow("critic-panel.js", { ...code, priorRecords: briefRecords([stored], [{ record_id: stored.record_id, action: "CLEAR" }]) }, clean);
    expect(cleared.result.completion.verdict).toBe("accept");
  });

  it("every lens dead (panel or single-pass; null or throw) is an error: defer, every lens failed, every key kept empty, no skeptic", async () => {
    for (const reviewMode of ["panel", "single-pass"]) {
      for (const reply of deadReplies("critic:")) {
        const { result, calls } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode }, reply);
        expect(result.error, reviewMode).toBe("all 5 lens(es) failed (infra) — no review happened; re-run");
        expect(result.completion.verdict).toBe("defer");
        expect(result.failedReviewers).toEqual(CODE_LENSES);
        expect(calls.filter((c) => !c.label.startsWith("critic:"))).toEqual([]);
        for (const k of ["confirmed", "deferred", "revised", "niceToHaves", "refuted", "traceRecords", "reuseActions"]) expect(result[k], k).toEqual([]);
      }
    }
  });
});

describe("round integrity: a whole-phase failure is an error, a partial one stays per item", () => {
  it("e2e-design: every category dead is an error with no cases; one dead category is named and the rest kept", async () => {
    const CATEGORY_LABELS = ["e2e:happy-0", "e2e:failure-1", "e2e:edge-2", "e2e:accessibility-3", "e2e:regression-4"];
    for (const reply of deadReplies("e2e:")) {
      const { result, calls } = await runWorkflow("e2e-design.js", { flow: "greeting" }, reply);
      expect(result).toEqual({ flow: "greeting", error: expect.stringContaining("failed (infra)"), failedCategories: ["happy", "failure", "edge", "accessibility", "regression"], count: 0, cases: [] });
      expect(calls.map((c) => c.label).sort()).toEqual([...CATEGORY_LABELS].sort());
    }
    const { result } = await runWorkflow("e2e-design.js", { flow: "greeting" }, (label) =>
      label.startsWith("e2e:edge") ? null : { cases: [{ title: `case for ${label}`, steps: "s", expected: "a visible greeting" }] },
    );
    expect(result.error).toBeUndefined();
    expect(result.failedCategories).toEqual(["edge"]);
    expect(result.cases.map((c) => c.category)).toEqual(["happy", "failure", "accessibility", "regression"]);
    expect(result.count).toBe(4);
  });

  const DIMENSIONS = ["docs-not-impl", "impl-not-docs", "impl-not-unit", "impl-not-e2e", "e2e-missing-edges", "ux-design", "ambiguous"];
  it("gap-analysis: every finder dead is an error with no synth call; one dead finder is named, absent from byDimension, and the rest synthesized", async () => {
    for (const reply of deadReplies("gap:")) {
      const { result, calls } = await runWorkflow("gap-analysis.js", { scope: "mvp" }, reply);
      expect(result.error).toContain("failed (infra)");
      expect(result.failedDimensions).toEqual(DIMENSIONS);
      expect(calls.filter((c) => !c.label.startsWith("gap:"))).toEqual([]);
    }
    const { result, calls } = await runWorkflow("gap-analysis.js", { scope: "mvp" }, (label) =>
      label.startsWith("gap:ux-design") ? null : label.startsWith("gap:") ? { gaps: [{ item: label, detail: "src/a.ts:1", priority: "high" }] } : { order: [{ next: "x", why: "y" }] },
    );
    expect(result.error).toBeUndefined();
    expect(result.failedDimensions).toEqual(["ux-design"]);
    expect(Object.keys(result.byDimension)).toEqual(DIMENSIONS.filter((d) => d !== "ux-design")); // a dead finder is not "no gaps"
    expect(result.totalGaps).toBe(6);
    expect(calls.filter((c) => c.label === "synthesize")).toHaveLength(1);
    expect(result.recommendedOrder).toEqual([{ next: "x", why: "y" }]);
    expect(result.missing).toEqual([]);
  });

  it("gap-analysis: a synthesizer that throws (or returns nothing) no longer aborts the run; recommendedOrder is null with a named missing", async () => {
    const dies = () => {
      throw new Error("synthesizer died");
    };
    for (const synth of [dies, () => null]) {
      const { result } = await runWorkflow("gap-analysis.js", { scope: "mvp" }, (label) => (label.startsWith("gap:") ? { gaps: [{ item: label, detail: "d", priority: "low" }] } : synth()));
      expect(result.error).toBeUndefined();
      expect(result.totalGaps).toBe(7);
      expect(result.recommendedOrder).toBeNull();
      expect(result.missing).toEqual([expect.stringMatching(/^a synthesized order — the synthesizer failed \(infra\)/)]);
    }
  });

  const LENS_KEYS = ["clarity", "instruction-following", "safety-gating", "consistency-dry", "workflow-dsl", "routing"];
  const metaFinding = { severity: "important", file: "CLAUDE.md", title: "Gate weakened", evidence: "CLAUDE.md:1", proposedEdit: "restore it" };
  it("improve-skills: every lens dead is an error and Verify is skipped; one dead lens is named and the rest verified", async () => {
    for (const reply of deadReplies("meta:")) {
      const { result, calls } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, reply);
      expect(result.error).toContain("failed (infra)");
      expect(result.failedReviewers).toEqual(LENS_KEYS);
      expect(result.budgetStop).toBe(false);
      expect(calls.filter((c) => !c.label.startsWith("meta:"))).toEqual([]);
      for (const k of ["applyReady", "needsDesign", "deferred", "niceToHaves", "refuted", "traceRecords"]) expect(result[k], k).toEqual([]);
    }
    const { result, calls } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:clarity") ? null : label.startsWith("meta:safety") ? { findings: [metaFinding] } : label.startsWith("meta:") ? { findings: [] } : null,
    );
    expect(result.error).toBeUndefined();
    expect(result.failedReviewers).toEqual(["clarity"]);
    expect(calls.filter((c) => c.label.startsWith("verify:"))).toHaveLength(1);
    expect(result.traceRecords).toHaveLength(1);
  });

  it("scan-docs: every evidence agent dead is an error that writes no records and changes no status", async () => {
    const stories = [{ id: "US-001", title: "Greeting", source: "docs/prd.md" }, { id: "US-002", title: "Farewell", source: "docs/prd.md" }];
    for (const reply of deadReplies("evidence:")) {
      const { result, calls } = await runWorkflow("scan-docs.js", { stories }, reply);
      expect(result.error).toContain("failed (infra)");
      expect(result.traceRecords).toEqual([]);
      expect(result.records.map((r) => [r.id, r.finalStatus])).toEqual([["US-001", null], ["US-002", null]]); // null = keep the current status
      expect(calls.filter((c) => !c.label.startsWith("evidence:"))).toEqual([]);
    }
  });

  it("loop-iteration: every implementer dead is an error with the full empty shape and no records; empty diffs are not dead implementers", async () => {
    const items = [{ id: "LP-020", description: "x" }, { id: "LP-021", description: "y" }];
    for (const reply of deadReplies("impl:")) {
      const { result, calls } = await runWorkflow("loop-iteration.js", { items, level: "L2" }, reply);
      expect(result).toEqual({ error: expect.stringContaining("failed (infra)"), level: "L2", applied: [], deferred: [], held: [], rejected: [], escalate: [], traceRecords: [] });
      expect(calls.filter((c) => !c.label.startsWith("impl:"))).toEqual([]);
    }
    const empty = await runWorkflow("loop-iteration.js", { items, level: "L2" }, (label) => (label.startsWith("impl:") ? { changedFiles: [], diff: "", checksPassed: true, notes: "" } : verdict()));
    expect(empty.result.error).toBeUndefined();
    expect(empty.result.deferred.map((o) => o.failedGates)).toEqual([["no-diff"], ["no-diff"]]);
  });
});

// The repo checkout is shared with the Lead, so every agent a read-only workflow starts gets the
// <agent-safety> block (byte-identical in each script: contracts.test.mjs). Each scenario reaches
// every agent() call site of its workflow: one blocker finding (or gap, or story), so the checker
// after the fan-out runs too.
describe("agent SAFETY: every prompt of a read-only workflow carries the <agent-safety> block", () => {
  const metaBlocker = { severity: "blocker", file: "CLAUDE.md", title: "Gate weakened", evidence: "CLAUDE.md:1", proposedEdit: "restore it" };
  const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
  const storyEvidence = { implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Present", proposedStatus: "E2E tested", notes: "" };
  it.each([
    ["critic-panel.js (panel, every lens)", "critic-panel.js", { focus: "x" }, (label) => (label.startsWith("critic:") ? onlySecurity([finding()])(label) : verdict()), ["critic:security", "verify:"]],
    ["critic-panel.js (single-pass)", "critic-panel.js", { focus: "x", uiInScope: false }, (label) => (label.startsWith("critic:") ? { findings: [finding({ lens: "security" })] } : verdict()), ["critic:all-lenses-0", "verify:"]],
    ["improve-skills.js", "improve-skills.js", { targets: ["CLAUDE.md"] }, (label) => (label.startsWith("meta:safety") ? { findings: [metaBlocker] } : label.startsWith("meta:") ? { findings: [] } : null), ["meta:", "verify:"]],
    ["scan-docs.js", "scan-docs.js", { stories: [story] }, (label) => (label.startsWith("evidence:") ? storyEvidence : { finalStatus: "E2E tested", justification: "j", missing: [], evidenceChecked: [] }), ["evidence:", "verify:"]],
    ["gap-analysis.js", "gap-analysis.js", { scope: "mvp" }, (label) => (label.startsWith("gap:") ? { gaps: [{ item: label, detail: "src/a.ts:1", priority: "high" }] } : { order: [] }), ["gap:", "synthesize"]],
    ["e2e-design.js", "e2e-design.js", { flow: "greeting" }, () => ({ cases: [] }), ["e2e:"]],
  ])("%s: every agent prompt carries AGENT_SAFETY", async (_name, file, args, reply, reached) => {
    const { AGENT_SAFETY } = loadWorkflowBlock("critic-panel.js", "agent-safety", ["AGENT_SAFETY"]);
    const { calls } = await runWorkflow(file, args, reply);
    for (const prefix of reached) expect(calls.some((c) => c.label.startsWith(prefix)), `no ${prefix} agent ran`).toBe(true);
    expect(calls.filter((c) => !c.prompt.includes(AGENT_SAFETY)).map((c) => c.label)).toEqual([]);
  });
});

// Cost bounds: an up-front story-batch cap (scan-docs), a per-round verifier cap whose overflow is
// recorded as explicit defers, never dropped (critic-panel; opt-in in improve-skills), and budget
// floors that fire only when the turn has a '+Nk' token target (budget.total set).
const VERIFY = (c) => c.label.startsWith("verify:");
const ALL_LENSES = ["first-time-user", "ux-flow", "designer", "artistic-direction", "frontend-arch", "qa-e2e", "accessibility", "performance", "security", "regression"];
const CAP_MISSING = (n) => `adversarial verification — skipped: verifier cap ${n} reached; re-run focused on this finding or raise args.maxVerifiers`;
const LOW = { total: 100_000, spent: () => 95_000, remaining: () => 5_000 }; // under every floor
const flat = (left) => ({ total: 1_000_000, spent: () => 1_000_000 - left, remaining: () => left });
// `start` tokens left until the first agent call, `after` from then on: the start floor sees `start`
// and a later floor (verify, pre-synth) sees `after`. `tap` wraps a reply so the call is noticed.
const draining = (start, after) => {
  let called = false;
  const budget = { total: 1_000_000, spent: () => 1_000_000 - budget.remaining(), remaining: () => (called ? after : start) };
  const tap = (reply) => (...rest) => {
    called = true;
    return reply(...rest);
  };
  return { budget, tap };
};
const noAgent = () => {
  throw new Error("no agent may start below a budget floor");
};

describe("cost bounds: scan-docs refuses a story batch over maxStories before any agent runs", () => {
  const stories = (n) => Array.from({ length: n }, (_, i) => ({ id: `US-${String(i + 1).padStart(3, "0")}`, title: `Story ${i + 1}`, source: "docs/prd.md" }));
  const live = (label) =>
    label.startsWith("evidence:")
      ? { implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Missing", proposedStatus: "Unit tested", notes: "" }
      : { finalStatus: "Unit tested", justification: "a unit test covers it", missing: [], evidenceChecked: [{ kind: "file_line", ref: "src/lib/greeting.test.ts:1" }] };

  it("31 stories (default maxStories 30) is an error with zero agent calls; 30 stories run, two agents each, and the plan is logged first", async () => {
    const over = await runWorkflow("scan-docs.js", { stories: stories(31) }, live);
    expect(over.calls).toEqual([]);
    expect(over.result).toEqual({ error: expect.stringMatching(/^31 stories > maxStories 30 \(62 agents\) — pass them in batches/), records: [], traceRecords: [] });
    const ok = await runWorkflow("scan-docs.js", { stories: stories(30) }, live);
    expect(ok.result.error).toBeUndefined();
    expect(ok.result.count).toBe(30);
    expect(ok.calls).toHaveLength(60);
    expect(ok.logs.filter((l) => /60 agents/.test(l.text)).map((l) => l.calls)).toEqual([0]);
    expectWritable(ok.result.traceRecords);
  });

  it("args.maxStories lowers the cap; a value that is not an integer > 0 keeps the default 30", async () => {
    const capped = await runWorkflow("scan-docs.js", { stories: stories(3), maxStories: 2 }, live);
    expect(capped.calls).toEqual([]);
    expect(capped.result.error).toMatch(/^3 stories > maxStories 2 \(6 agents\) — pass them in batches/);
    expect((await runWorkflow("scan-docs.js", { stories: stories(2), maxStories: 2 }, live)).result.count).toBe(2);
    for (const maxStories of [0, -1, 2.5, "2", null]) {
      const { result } = await runWorkflow("scan-docs.js", { stories: stories(3), maxStories }, live);
      expect(result.error, String(maxStories)).toBeUndefined();
      expect(result.count, String(maxStories)).toBe(3);
    }
  });
});

describe("cost bounds: critic-panel verifier cap (args.maxVerifiers, default 30)", () => {
  const code = { focus: "x", uiInScope: false, reviewMode: "panel" };
  const importants = (lens, n) => Array.from({ length: n }, (_, k) => finding({ severity: "important", title: `${lens} finding ${k + 1}`, evidence: `src/${lens}.ts:${k + 1}` }));
  // 2 blockers + 35 importants over the 5 code lenses, in review order. Filling the cap in that
  // order would give frontend-arch 15 slots and starve regression.
  const byLens = {
    "frontend-arch": importants("frontend-arch", 15),
    "qa-e2e": importants("qa-e2e", 5),
    performance: importants("performance", 5),
    security: [finding({ title: "Token in URL" }), ...importants("security", 5)],
    regression: [finding({ title: "Route removed" }), ...importants("regression", 5)],
  };
  const reply = (label) => {
    const m = /^critic:([a-z0-9-]+)-\d+$/.exec(label);
    return m ? { findings: byLens[m[1]] || [] } : verdict();
  };

  it("2 blockers + 35 importants, cap 30: both blockers and 28 importants get a skeptic, round-robin across lenses; the other 7 are recorded cap defers", async () => {
    for (const args of [code, { ...code, maxVerifiers: 30 }]) {
      const { result, calls, logs } = await runWorkflow("critic-panel.js", args, reply);
      const verifyCalls = calls.filter(VERIFY);
      expect(verifyCalls).toHaveLength(30);
      expect(result.confirmed.filter((f) => f.severity === "blocker").map((f) => f.title).sort()).toEqual(["Route removed", "Token in URL"]);
      const perLens = {};
      for (const f of result.confirmed.filter((o) => o.severity === "important")) perLens[f.critic] = (perLens[f.critic] || 0) + 1;
      expect(perLens).toEqual({ "frontend-arch": 8, "qa-e2e": 5, performance: 5, security: 5, regression: 5 });
      // Labels keep each finding's index in review order (0-36), never a renumbered 0-29.
      const indices = verifyCalls.map((c) => Number(c.label.split(":").pop())).sort((x, y) => x - y);
      expect(indices).toEqual([...Array(8).keys(), ...Array.from({ length: 22 }, (_, k) => 15 + k)]);
      expect(result.counts.capDeferred).toBe(7);
      expect(result.deferred).toHaveLength(7);
      for (const f of result.deferred) {
        expect(f).toMatchObject({ severity: "important", critic: "frontend-arch", verdict: "defer", failedGates: ["not-verified:verifier-cap"], missing: [CAP_MISSING(30)] });
      }
      expect(result.traceRecords).toHaveLength(37);
      expect(result.traceRecords.filter((r) => r.final_status === "defer").map((r) => r.failed_gates)).toEqual(Array(7).fill(["not-verified:verifier-cap"]));
      expectWritable(result.traceRecords);
      expect(logs.some((l) => /maxVerifiers 30/.test(l.text) && /7 cap-deferred/.test(l.text) && l.calls === 5)).toBe(true);
    }
  });

  it("a reused verdict takes no slot; every blocker is verified even past the cap; an invalid cap keeps the default", async () => {
    const prior = { record_id: "TR-aaaaaaaaaaaa", claim_id: "critic:security:input-has-no-accessible-name", claim_text: "Input has no accessible name", claim_type: "factual", final_status: "accept", missing: [], reason: "verified earlier", provenance: { tree: TREE } };
    const reused = await runWorkflow("critic-panel.js", { ...code, maxVerifiers: 1, priorRecords: [prior], treeId: TREE }, (label) =>
      label.startsWith("critic:")
        ? onlySecurity([finding({ severity: "important", revisits: prior.record_id, revisitReason: "still-present" }), finding({ severity: "important", title: "Token logged" })])(label)
        : verdict(),
    );
    expect(reused.calls.filter(VERIFY)).toHaveLength(1);
    expect(reused.result.reuseActions).toEqual([expect.objectContaining({ record_id: prior.record_id, action: "REUSE" })]);
    expect(reused.result.counts.capDeferred).toBe(0);
    expect(reused.result.confirmed.map((f) => f.title).sort()).toEqual(["Input has no accessible name", "Token logged"]);

    const blockerAndImportant = (label) => (label.startsWith("critic:") ? onlySecurity([finding(), finding({ severity: "important", title: "Token logged" })])(label) : verdict());
    const zero = await runWorkflow("critic-panel.js", { ...code, maxVerifiers: 0 }, blockerAndImportant);
    expect(zero.calls.filter(VERIFY).map((c) => c.label)).toEqual(["verify:security:0"]);
    expect(zero.result.counts.capDeferred).toBe(1);
    expect(zero.result.deferred).toEqual([expect.objectContaining({ title: "Token logged", failedGates: ["not-verified:verifier-cap"], missing: [CAP_MISSING(0)] })]);
    expect(zero.result.completion.verdict).toBe("reject"); // the confirmed blocker; a deferred important never holds the round
    expectWritable(zero.result.traceRecords);
    for (const maxVerifiers of [-1, 1.5, "0", null]) {
      const { calls } = await runWorkflow("critic-panel.js", { ...code, maxVerifiers }, blockerAndImportant);
      expect(calls.filter(VERIFY), String(maxVerifiers)).toHaveLength(2);
    }
  });
});

describe("cost bounds: improve-skills verifier cap (opt-in: uncapped unless args.maxVerifiers is set)", () => {
  const mf = (severity, title) => ({ severity, file: "CLAUDE.md", title, evidence: "CLAUDE.md:1", proposedEdit: "tighten it" });
  // Review order: clarity (c1-c3) comes before routing (r0-r3), so filling a cap of 2 importants in
  // review order would take c1 and c2 and starve routing.
  const byLens = { clarity: [mf("important", "c1"), mf("important", "c2"), mf("important", "c3")], routing: [mf("blocker", "r0"), mf("important", "r1"), mf("important", "r2"), mf("important", "r3")] };
  const safe = { real: true, editSafe: true, saferEdit: "", missing: [], evidenceChecked: [{ kind: "rule", ref: "CLAUDE.md: never weaken a gate" }, { kind: "file_line", ref: "CLAUDE.md:1" }], reason: "ok" };
  const reply = (label) => {
    const m = /^meta:([a-z0-9-]+)-\d+$/.exec(label);
    return m ? { findings: byLens[m[1]] || [] } : safe;
  };

  it("uncapped by default: every blocker and important finding gets a skeptic, and the planned count is logged before Verify", async () => {
    const { result, calls, logs } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, reply);
    expect(calls.filter(VERIFY)).toHaveLength(7);
    expect(result.counts.capDeferred).toBe(0);
    expect(logs.filter((l) => /7 skeptic\(s\) planned/.test(l.text)).map((l) => l.calls)).toEqual([6]); // after the 6 lenses, before any skeptic
  });

  it("args.maxVerifiers: every blocker, then importants round-robin across lenses; the rest are recorded as unverified defers", async () => {
    const { result, calls } = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"], maxVerifiers: 3 }, reply);
    expect(calls.filter(VERIFY)).toHaveLength(3);
    expect(result.applyReady.map((f) => f.title).sort()).toEqual(["c1", "r0", "r1"]);
    expect(result.counts.capDeferred).toBe(4);
    expect(result.deferred.map((f) => f.title).sort()).toEqual(["c2", "c3", "r2", "r3"]);
    for (const f of result.deferred) expect(f).toMatchObject({ verdict: "defer", editSafe: false, failedGates: ["not-verified:verifier-cap"], missing: [CAP_MISSING(3)] });
    expect(result.traceRecords).toHaveLength(7);
    expectWritable(result.traceRecords);
  });
});

describe("cost bounds: budget floors (only with a '+Nk' token target)", () => {
  const code = { focus: "x", uiInScope: false, reviewMode: "panel" };
  const securityPrior = {
    record_id: "TR-aaaaaaaaaaa1", claim_id: "critic:security:token-in-url", claim_text: "Token in URL", claim_type: "factual", severity: "important",
    final_status: "accept", qualifier: "", repair: "", failed_gates: [], missing: [], reason: "r", provenance: { tree: TREE }, created_at: "2026-10-07T12:00:00.000Z", cleared: false,
  };

  it("critic-panel start floor (80k): error + budgetStopped with zero agent calls; every in-scope lens failed, every key kept, completion defer naming the floor", async () => {
    for (const [args, lenses] of [[code, CODE_LENSES], [{ focus: "x", uiInScope: false }, CODE_LENSES], [{ focus: "x" }, ALL_LENSES]]) {
      const { result, calls } = await runWorkflow("critic-panel.js", { ...args, priorRecords: [securityPrior] }, noAgent, LOW);
      expect(calls).toEqual([]);
      expect(result.budgetStopped).toBe(true);
      expect(result.error).toMatch(/^token budget floor reached before Review \(5k left < 80k\) — no review happened/);
      expect(result.failedReviewers).toEqual(lenses);
      expect(result.completion).toEqual({
        claim: "no open blocker in: x",
        verdict: "defer",
        missing: lenses.map((k) => `a review through the ${k} lens — not started: token budget floor reached before Review (5k left < 80k)`),
        notRechecked: [securityPrior.record_id],
      });
      const normal = await runWorkflow("critic-panel.js", args, () => ({ findings: [] }));
      expect(Object.keys(result).sort()).toEqual([...Object.keys(normal.result), "error", "budgetStopped"].sort());
      for (const k of ["confirmed", "deferred", "revised", "niceToHaves", "refuted", "traceRecords", "reuseActions"]) expect(result[k], k).toEqual([]);
      expect(result.counts).toMatchObject({ reviewAgents: 0, failedReviewers: lenses.length, capDeferred: 0 }); // no agent started
    }
    // Completion is the normal computation: an open prior blocker of a lens out of scope is named too.
    const designer = { ...securityPrior, record_id: "TR-eeeeeeeeeee1", claim_id: "critic:designer:button-spacing-is-off", severity: "blocker" };
    const { result } = await runWorkflow("critic-panel.js", { ...code, priorRecords: [securityPrior, designer] }, noAgent, LOW);
    expect(result.completion.missing.slice(-1)).toEqual([`re-review of the designer lens for open prior blocker ${designer.record_id} (or CLEAR it on verified evidence)`]);
    expect(result.completion.notRechecked).toEqual([securityPrior.record_id, designer.record_id]);
  });

  it("critic-panel start floor boundary: 79k left stops the round, 81k starts it; with no target (total null) nothing stops", async () => {
    const clean = () => ({ findings: [] });
    const below = await runWorkflow("critic-panel.js", code, noAgent, flat(79_000));
    expect([below.result.budgetStopped, below.calls.length]).toEqual([true, 0]);
    const above = await runWorkflow("critic-panel.js", code, clean, flat(81_000));
    expect([above.result.budgetStopped, above.calls.length]).toEqual([undefined, 5]);
    const untargeted = await runWorkflow("critic-panel.js", code, clean, { total: null, spent: () => 0, remaining: () => 0 });
    expect([untargeted.result.budgetStopped, untargeted.calls.length]).toEqual([undefined, 5]);
  });

  it("critic-panel verify floor (60k): no skeptic starts; every fresh blocker and important finding is a recorded budget defer, a reused verdict stays reused, and the deferred blocker keeps completion at defer", async () => {
    const prior = { record_id: "TR-aaaaaaaaaaaa", claim_id: "critic:security:input-has-no-accessible-name", claim_text: "Input has no accessible name", claim_type: "factual", final_status: "accept", missing: [], reason: "verified earlier", provenance: { tree: TREE } };
    const findings = [
      finding({ severity: "important", revisits: prior.record_id, revisitReason: "still-present" }),
      finding({ title: "Token in URL" }),
      finding({ severity: "important", title: "Token logged" }),
      finding({ severity: "nice-to-have", title: "Rename a variable" }),
    ];
    const run = (left) => {
      const d = draining(200_000, left);
      return runWorkflow("critic-panel.js", { ...code, priorRecords: [prior], treeId: TREE }, d.tap((label) => (label.startsWith("critic:") ? onlySecurity(findings)(label) : verdict())), d.budget);
    };
    const { result, calls } = await run(50_000);
    expect(calls.filter(VERIFY)).toEqual([]);
    expect(result.budgetStopped).toBeUndefined(); // the review ran
    expect(result.reuseActions).toEqual([expect.objectContaining({ record_id: prior.record_id, action: "REUSE" })]);
    expect(result.deferred.map((f) => [f.severity, f.title])).toEqual([["blocker", "Token in URL"], ["important", "Token logged"]]);
    for (const f of result.deferred) {
      expect(f.failedGates).toEqual(["not-verified:budget"]);
      expect(f.missing).toEqual([expect.stringContaining("token budget floor reached before Verify (50k left < 60k)")]);
    }
    expect(result.counts.capDeferred).toBe(0);
    expect(result.niceToHaves).toHaveLength(1);
    expect(result.completion.verdict).toBe("defer");
    expect(result.completion.missing).toEqual([expect.stringMatching(/^blocker "Token in URL" \(security\) is deferred — missing: .*token budget floor/)]);
    expectWritable(result.traceRecords);
    // 70k left at Verify, above its 60k floor: the two skeptics run.
    expect((await run(70_000)).calls.filter(VERIFY)).toHaveLength(2);
  });

  it("scan-docs (60k) and gap-analysis (40k) start floors: an error with zero agent calls; just above each floor the run starts", async () => {
    const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
    const liveScan = (label) => (label.startsWith("evidence:") ? { implementationFiles: [], unitTests: "Missing", e2eTests: "Missing", proposedStatus: "Not started", notes: "" } : { finalStatus: "Not started", justification: "j", missing: [], evidenceChecked: [{ kind: "file_line", ref: "src/a.ts:1" }] });
    const liveGap = (label) => (label.startsWith("gap:") ? { gaps: [] } : { order: [] });
    const scan = await runWorkflow("scan-docs.js", { stories: [story] }, noAgent, LOW);
    expect(scan.calls).toEqual([]);
    expect(scan.result).toEqual({ error: expect.stringContaining("token budget floor reached (5k left < 60k)"), budgetStopped: true, count: 0, records: [], traceRecords: [] });
    const gap = await runWorkflow("gap-analysis.js", { scope: "mvp" }, noAgent, LOW);
    expect(gap.calls).toEqual([]);
    expect(gap.result).toMatchObject({ error: expect.stringContaining("token budget floor reached (5k left < 40k)"), budgetStopped: true, totalGaps: 0, byDimension: {}, recommendedOrder: null });
    expect((await runWorkflow("scan-docs.js", { stories: [story] }, noAgent, flat(59_000))).calls).toEqual([]);
    expect((await runWorkflow("scan-docs.js", { stories: [story] }, liveScan, flat(61_000))).calls).toHaveLength(2);
    expect((await runWorkflow("gap-analysis.js", { scope: "mvp" }, noAgent, flat(39_000))).calls).toEqual([]);
    expect((await runWorkflow("gap-analysis.js", { scope: "mvp" }, liveGap, flat(41_000))).calls).toHaveLength(8);
  });

  it("gap-analysis pre-synth floor (20k): the gaps stand unordered, no synthesize call, a null order with its missing", async () => {
    const reply = (label) => (label.startsWith("gap:") ? { gaps: [{ item: label, detail: "src/a.ts:1", priority: "high" }] } : { order: [{ next: "x", why: "y" }] });
    const low = draining(100_000, 10_000);
    const { result, calls } = await runWorkflow("gap-analysis.js", { scope: "mvp" }, low.tap(reply), low.budget);
    expect(calls.filter((c) => c.label === "synthesize")).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.totalGaps).toBe(7);
    expect(result.recommendedOrder).toBeNull();
    expect(result.missing).toEqual([expect.stringContaining("synthesis skipped: token budget floor")]);
    const enough = draining(100_000, 30_000);
    expect((await runWorkflow("gap-analysis.js", { scope: "mvp" }, enough.tap(reply), enough.budget)).result.recommendedOrder).toEqual([{ next: "x", why: "y" }]);
  });
});

// Cases the round-integrity tests did not pin (each kills a named mutation of critic-panel.js).
describe("critic-panel completion and failedReviewers: qualified blockers, important-only defers, a synchronously throwing critic", () => {
  const code = { focus: "x", uiInScope: false, reviewMode: "panel" };

  it("a blocker the skeptic confirms at qualify is reject: a qualified blocker is still a confirmed blocker", async () => {
    const { result } = await runWorkflow("critic-panel.js", code, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding()])(label) : verdict({ verdict: "qualify", qualifier: "only on the mobile layout" }),
    );
    expect(result.confirmed).toEqual([expect.objectContaining({ severity: "blocker", verdict: "qualify", qualifier: "only on the mobile layout" })]);
    expect(result.completion.verdict).toBe("reject");
  });

  it("a deferred or revised IMPORTANT finding with no blocker leaves completion accept with nothing missing", async () => {
    for (const v of [verdict({ verdict: "defer", missing: ["an axe run on /"] }), verdict({ verdict: "revise", repair: "only the email input lacks a name" })]) {
      const { result } = await runWorkflow("critic-panel.js", code, (label) => (label.startsWith("critic:") ? onlySecurity([finding({ severity: "important" })])(label) : v));
      expect(result.deferred.length + result.revised.length, v.verdict).toBe(1);
      expect(result.completion, v.verdict).toMatchObject({ verdict: "accept", missing: [] });
    }
  });

  it("panel: a critic whose agent() throws synchronously (a null parallel() slot, past its .catch) is named by its lens key and the round completes", async () => {
    const { result, logs } = await runWorkflow("critic-panel.js", code, throwingSync("critic:qa-e2e", () => ({ findings: [] })));
    expect(logs.some((l) => l.text.startsWith("agent failed: critic:qa-e2e"))).toBe(false); // the .catch never ran: the slot itself is null
    expect(result.failedReviewers).toEqual(["qa-e2e"]);
    expect(result.error).toBeUndefined();
    expect(result.completion).toMatchObject({ verdict: "defer", missing: ["a review through the qa-e2e lens — its reviewer failed (infra)"] });
  });
});

// 'agent-failed' is the workflow's own infra signal (trace.md: re-run, never wait for evidence), so a
// live checker must not be able to set it: the evidence gate copies a checker's own failedGates.
describe("only workflow code sets 'agent-failed': a live checker cannot forge the infra signal", () => {
  it("critic-panel: a live skeptic's own 'agent-failed' gate is dropped from the finding and its record; its other gates are kept", async () => {
    const { result } = await runWorkflow("critic-panel.js", { focus: "x", uiInScope: false, reviewMode: "panel" }, (label) =>
      label.startsWith("critic:") ? onlySecurity([finding()])(label) : verdict({ verdict: "defer", missing: ["an axe run on /"], failedGates: ["agent-failed", "needs-axe"] }),
    );
    expect(result.deferred[0].failedGates).toEqual(["needs-axe"]);
    expect(result.traceRecords[0].failed_gates).toEqual(["needs-axe"]);
    expectWritable(result.traceRecords);
  });

  it("improve-skills and scan-docs: a live checker's failedGates never reach the record (workflow code builds the gate input)", async () => {
    const forged = { failedGates: ["agent-failed"] };
    const metaFinding = { severity: "important", file: "CLAUDE.md", title: "Gate weakened", evidence: "CLAUDE.md:1", proposedEdit: "restore it" };
    const skills = await runWorkflow("improve-skills.js", { targets: ["CLAUDE.md"] }, (label) =>
      label.startsWith("meta:safety")
        ? { findings: [metaFinding] }
        : label.startsWith("meta:")
          ? { findings: [] }
          : { real: true, editSafe: true, saferEdit: "", missing: [], evidenceChecked: [{ kind: "rule", ref: "CLAUDE.md rule" }, { kind: "file_line", ref: "CLAUDE.md:1" }], reason: "ok", ...forged },
    );
    expect(skills.result.traceRecords.map((r) => r.failed_gates)).toEqual([[]]);
    const story = { id: "US-001", title: "Greeting", source: "docs/prd.md" };
    const scan = await runWorkflow("scan-docs.js", { stories: [story] }, (label) =>
      label.startsWith("evidence:")
        ? { implementationFiles: ["src/lib/greeting.ts"], unitTests: "Present", e2eTests: "Present", proposedStatus: "E2E tested", notes: "" }
        : { finalStatus: "E2E tested", justification: "a spec covers it", missing: [], evidenceChecked: [{ kind: "file_line", ref: "e2e/greeting.spec.ts:1" }], ...forged },
    );
    expect(scan.result.traceRecords.map((r) => r.failed_gates)).toEqual([[]]);
  });
});
