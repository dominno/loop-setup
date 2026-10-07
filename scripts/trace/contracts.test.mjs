// Drift + integrity gates for the TRACE-lite machinery: every place that must agree with
// the canonical policy is checked here, so `pnpm test` (CI) fails on drift instead of a
// reviewer having to notice it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_ALLOWED,
  BENCH_BUNDLE,
  DEFAULT_STORE,
  EVIDENCE_POLICY,
  POLICY_PATH,
  ROOT,
  loadEntries,
  loadSchema,
  benchArgs,
  contaminatedRuns,
  encodeBench,
  loadWorkflowBlock,
  manifestViolations,
  markContaminated,
  opaqueFixtureId,
  readBench,
  scoreBench,
  readPolicyVersion,
  replay,
} from "./lib.mjs";

const WF_DIR = join(ROOT, ".claude/workflows");
const workflows = readdirSync(WF_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ name: f, text: readFileSync(join(WF_DIR, f), "utf8") }));
const lib = readFileSync(join(ROOT, "scripts/trace/lib.mjs"), "utf8");
const schema = loadSchema();

const block = (text, tag) => {
  const m = new RegExp(`// <${tag}>\\n[\\s\\S]*?// </${tag}>\\n`).exec(text);
  return m ? m[0] : null;
};

describe("workflow scripts", () => {
  it.each(workflows.map((w) => [w.name, w.text]))("%s compiles and its meta is a pure literal", (_name, text) => {
    // The Workflow DSL runs the body as an async function with these globals.
    const body = text.replace(/^export const meta =/m, "const meta =");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", body)).not.toThrow();
    const metaSrc = /^export const meta = (\{[\s\S]*?\n\})\n/m.exec(text);
    expect(metaSrc).not.toBeNull();
    const meta = new Function(`return (${metaSrc[1]})`)();
    expect(typeof meta.name).toBe("string");
    expect(typeof meta.description).toBe("string");
  });

  it("every inlined evidence gate is byte-identical to the canonical block in lib.mjs", () => {
    const canonical = block(lib, "trace-evidence-gate");
    expect(canonical).not.toBeNull();
    const carriers = workflows.filter((w) => w.text.includes("// <trace-evidence-gate>"));
    expect(carriers.map((w) => w.name).sort()).toEqual(["critic-panel.js", "loop-iteration.js", "trace-bench.js"]);
    for (const w of carriers) expect(block(w.text, "trace-evidence-gate"), w.name).toBe(canonical);
  });

  it.each([
    ["loop-denylist", "loop-iteration.js"],
    ["loop-verifier", "loop-iteration.js"],
    ["critic-roster", "critic-panel.js"],
  ])("trace-bench's <%s> block is byte-identical to %s (the bench measures the production checker)", (tag, source) => {
    const canonical = block(workflows.find((w) => w.name === source).text, tag);
    expect(canonical).not.toBeNull();
    const bench = workflows.find((w) => w.name === "trace-bench.js");
    expect(block(bench.text, tag)).toBe(canonical);
  });

  it("workflow evidence-kind lists match the schema enum", () => {
    const schemaKinds = schema.$defs.evidenceItem.properties.kind.enum;
    for (const w of workflows.filter((x) => x.text.includes("const EVIDENCE_KINDS ="))) {
      const src = /const EVIDENCE_KINDS = (\[[^\]]*\])/.exec(w.text)[1];
      expect(new Function(`return ${src}`)(), w.name).toEqual(schemaKinds);
    }
  });

  it("every verdict-producing workflow returns traceRecords", () => {
    for (const name of ["critic-panel.js", "loop-iteration.js", "improve-skills.js", "scan-docs.js"]) {
      const w = workflows.find((x) => x.name === name);
      expect(w, name).toBeTruthy();
      expect(w.text, name).toMatch(/traceRecords/);
    }
  });
});

describe("policy page ↔ code", () => {
  const page = readFileSync(POLICY_PATH, "utf8");

  it("declares a policy version", () => {
    expect(readPolicyVersion()).toBeGreaterThanOrEqual(1);
  });

  it("the evidence-standard table matches EVIDENCE_POLICY", () => {
    const rows = [...page.matchAll(/^\| (factual|measured|causal|predictive|normative|practical) \| [^|]*\| ([^|]+) \| (defer|qualify) \|$/gm)];
    const parsed = Object.fromEntries(rows.map((r) => [r[1], { acceptNeeds: r[2].split(",").map((s) => s.trim()), onFail: r[3] }]));
    const expected = Object.fromEntries(Object.entries(EVIDENCE_POLICY).map(([k, v]) => [k, { acceptNeeds: v.acceptNeeds, onFail: v.onFail }]));
    expect(parsed).toEqual(expected);
  });

  it("the consumer-action table matches ACTION_ALLOWED", () => {
    const rows = [...page.matchAll(/^\| ([A-Z_]+) \| ([^|]+) \| [^|]+ \|$/gm)].filter((r) => r[1] in ACTION_ALLOWED);
    const parsed = Object.fromEntries(rows.map((r) => [r[1], r[2].trim() === "any" ? "any" : r[2].split(",").map((s) => s.trim())]));
    const expected = Object.fromEntries(
      Object.entries(ACTION_ALLOWED).map(([k, v]) => [k, v.length === 5 ? "any" : v]),
    );
    expect(parsed).toEqual(expected);
  });
});

describe("committed record store", () => {
  it("replays cleanly — every record and action satisfies the contract", () => {
    const state = replay(loadEntries(DEFAULT_STORE), schema, readPolicyVersion());
    expect(state.errors).toEqual([]);
  });
});

describe("TRACE-Bench-lite fixtures", () => {
  const manifest = readBench();
  const { hitsDenylist, parseDiffPaths } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist", "parseDiffPaths"]);

  it("the bundle decodes to a structurally valid manifest and re-encodes byte-identically", () => {
    expect(manifestViolations(manifest)).toEqual([]);
    expect(encodeBench(manifest)).toBe(readFileSync(BENCH_BUNDLE, "utf8"));
  });

  it("no ground truth is readable as plain text anywhere in the tree (bench agents grep it)", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter((p) => p && !p.endsWith(".bundle") && !p.startsWith("node_modules/"));
    const markers = manifest.fixtures.flatMap((f) => [f.id, ...(f.defect ? [f.defect.slice(0, 60)] : [])]);
    const leaks = [];
    for (const p of tracked) {
      let text;
      try {
        text = readFileSync(join(ROOT, p), "utf8");
      } catch {
        continue;
      }
      for (const m of markers) if (text.includes(m)) leaks.push(`${p}: ${m}`);
    }
    expect(leaks).toEqual([]);
  });

  it.each(manifest.fixtures.map((f) => [f.id, f]))("%s applies cleanly to the current tree", (_id, f) => {
    expect(() => execFileSync("git", ["apply", "--check", "-"], { cwd: ROOT, input: f.patch, stdio: ["pipe", "pipe", "pipe"] })).not.toThrow();
  });

  it("bench args leak no ground truth to the agents (ids, class, defect, judge)", () => {
    const args = benchArgs(manifest, {});
    const text = JSON.stringify(args);
    for (const f of manifest.fixtures) {
      expect(text, f.id).not.toContain(f.id);
      if (f.defect) expect(text).not.toContain(f.defect);
    }
    expect(args.fixtures.every((f) => /^fx-[0-9a-f]{8}$/.test(f.id))).toBe(true);
    expect(text).not.toMatch(/"kind"|"defect"|"judge"|"lenses"/);
  });

  it("scoring maps opaque tokens back, and excludes runs whose transcript leaked ground truth (F0)", () => {
    const [b] = manifest.fixtures.filter((f) => f.kind === "bad");
    const token = opaqueFixtureId(b.id);
    const runs = [{ arm: "verifier", repeat: 0, fixtureId: token, verdict: "accept", preGateVerdict: "accept" }];
    expect(scoreBench(manifest, { runs }).arms.verifier.wrongAcceptRate).toBe(1);
    const keys = contaminatedRuns([{ label: `bench-verify:${token}-r0-0`, text: `... read ${b.id} ...` }, { label: `bench-verify:${token}-r1-0`, text: "clean" }], manifest);
    expect(keys).toEqual([{ arm: "verifier", token, repeat: 0 }]);
    const s = scoreBench(manifest, { runs: markContaminated(runs, keys) });
    expect(s.contaminatedRuns).toBe(1);
    expect(s.arms.verifier).toBeUndefined();
    expect(s.flags.some((f) => f.startsWith("F0"))).toBe(true);
  });

  it("denylist judges agree with the production denylist, and good fixtures never hit it", () => {
    for (const f of manifest.fixtures) {
      const hit = hitsDenylist(parseDiffPaths(f.patch));
      if (f.judge.kind === "denylist") expect(hit, f.id).toBe(f.judge.catches);
      if (f.kind === "good") expect(hit, f.id).toBe(false);
    }
  });
});
