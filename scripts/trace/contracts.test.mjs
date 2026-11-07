// Drift + integrity gates for the TRACE-lite machinery: every place that must agree with
// the canonical policy is checked here, so `pnpm test` (CI) fails on drift instead of a
// reviewer having to notice it.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  ACTION_ALLOWED,
  BENCH_BUNDLE,
  DEFAULT_STORE,
  EVIDENCE_POLICY,
  POLICY_PATH,
  ROOT,
  WIKI_LIMITS,
  loadEntries,
  loadSchema,
  loadWiki,
  wikiViolations,
  benchArgs,
  briefRecords,
  contaminatedRuns,
  encodeBench,
  leakyFiles,
  loadWorkflowBlock,
  manifestViolations,
  markContaminated,
  opaqueFixtureId,
  readBench,
  scoreBench,
  readPolicyVersion,
  replay,
} from "./lib.mjs";
import { DEFAULT_PLAN, NOT_READY, STATUSES, parsePlan, planViolations, PLAN_COLUMNS_FULL } from "./plan.mjs";
import { STORY_MAP_PATHS, STORY_STATUSES, storyMapViolations } from "./story-map.mjs";

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
    expect(carriers.map((w) => w.name).sort()).toEqual(["critic-panel.js", "e2e-design.js", "gap-analysis.js", "improve-skills.js", "loop-iteration.js", "scan-docs.js", "trace-bench.js"]);
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

  // Every agent a read-only workflow starts gets the same SAFETY rules: the checkout is shared
  // with the Lead. Never in a measured prompt: the loop verifier and the bench arms must stay
  // exactly what was benched (adding it there is a separate decision that needs a re-bench).
  it("the <agent-safety> block is byte-identical in exactly the five read-only workflows", () => {
    const canonical = block(workflows.find((w) => w.name === "critic-panel.js").text, "agent-safety");
    expect(canonical).not.toBeNull();
    const carriers = workflows.filter((w) => w.text.includes("// <agent-safety>"));
    expect(carriers.map((w) => w.name).sort()).toEqual(["critic-panel.js", "e2e-design.js", "gap-analysis.js", "improve-skills.js", "scan-docs.js"]);
    for (const w of carriers) expect(block(w.text, "agent-safety"), w.name).toBe(canonical);
  });

  it("AGENT_SAFETY keeps its hard rules (read-only checkout, scratch copy, no E2E or server, no piped exit status)", () => {
    const { AGENT_SAFETY } = loadWorkflowBlock("critic-panel.js", "agent-safety", ["AGENT_SAFETY"]);
    for (const rule of ["read-only", "mktemp -d", "pnpm test:e2e", "pkill", "missing evidence", "head or tail"]) expect(AGENT_SAFETY, rule).toContain(rule);
  });

  // rsync is not installed in the remote environment (agents then improvise); tar is everywhere.
  // The example defines its own scratch dir and extracts into it, never into the checkout. Its
  // excludes are unanchored: GNU tar matches '--exclude=./node_modules' only at the top level, so
  // a loop worktree's own node_modules and .next (under .claude/worktrees/) would be copied too.
  it("SAFETY rule (2)'s scratch-copy example is a portable tar pipe, not rsync", () => {
    const carriers = workflows.filter((w) => w.text.includes("// <agent-safety>"));
    expect(carriers).toHaveLength(5);
    for (const w of carriers) {
      const safety = block(w.text, "agent-safety");
      expect(safety, w.name).toContain("mktemp -d");
      expect(safety, w.name).toContain("tar ");
      expect(safety, w.name).not.toContain("rsync");
      expect(safety, w.name).toContain('D=$(mktemp -d) && tar -cf - ');
      expect(safety, w.name).toContain("--exclude=node_modules --exclude=.next . |");
      expect(safety, w.name).toContain('| tar -xf - -C "$D" && ln -s "$PWD/node_modules" "$D/node_modules"');
    }
  });

  it("no measured prompt carries it: neither trace-bench.js nor the <loop-verifier> block", () => {
    const bench = workflows.find((w) => w.name === "trace-bench.js").text;
    expect(bench).not.toContain("agent-safety");
    expect(bench).not.toContain("AGENT_SAFETY");
    const verifier = block(workflows.find((w) => w.name === "loop-iteration.js").text, "loop-verifier");
    expect(verifier).not.toBeNull();
    expect(verifier).not.toContain("AGENT_SAFETY");
  });

  it("workflow evidence-kind lists match the schema enum", () => {
    const schemaKinds = schema.$defs.evidenceItem.properties.kind.enum;
    for (const w of workflows.filter((x) => x.text.includes("const EVIDENCE_KINDS ="))) {
      const src = /const EVIDENCE_KINDS = (\[[^\]]*\])/.exec(w.text)[1];
      expect(new Function(`return ${src}`)(), w.name).toEqual(schemaKinds);
    }
  });

  // e2e-design and gap-analysis produce typed verdicts too, but they are advisory and write no records.
  it("every record-writing workflow returns traceRecords", () => {
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

  // `pnpm trace wiki-check` over the real wiki: every rec: comment, every committed fact and every
  // quarantine row agrees with the store. (Mid-ingest, between a bullet and its COMMIT, this is red.)
  it("the wiki agrees with the store", () => {
    const state = replay(loadEntries(DEFAULT_STORE), schema, readPolicyVersion());
    expect(wikiViolations({ ...loadWiki(), state }).errors).toEqual([]);
  });

  // The policy page is parsed by tests and grows with the policy, so its own size limit is measured on
  // the real page, not only on a synthetic one: past it, split the page rather than raise the limit.
  it("the real policy page is scanned and within its own size limit", () => {
    const wiki = loadWiki();
    expect(wiki.pages.map((p) => p.path)).toContain(WIKI_LIMITS.policyPage);
    const state = replay(loadEntries(DEFAULT_STORE), schema, readPolicyVersion());
    expect(wikiViolations({ ...wiki, state }).warnings.filter((w) => w.startsWith(`${WIKI_LIMITS.policyPage}:`))).toEqual([]);
  });
});

// The loop plan is the loop's state: `pnpm trace plan-lint` must pass on what is committed (an
// in-progress node is only a warning here, since this can run mid-loop), and plan.mjs must read
// the same status list and ready rule that loop-plan.md documents.
describe("committed loop plan ↔ plan.mjs", () => {
  const doc = readFileSync(DEFAULT_PLAN, "utf8");

  it("the committed plan and store pass plan-lint with no errors", () => {
    const state = replay(loadEntries(DEFAULT_STORE), schema, readPolicyVersion());
    expect(planViolations(parsePlan(doc), state).errors).toEqual([]);
  });

  it("the Node schema table documents every column of the plan header, in order, and the live table uses the full header", () => {
    const schemaTable = doc.slice(doc.indexOf("## Node schema"), doc.indexOf("**Status meaning**"));
    expect([...schemaTable.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1])).toEqual(PLAN_COLUMNS_FULL);
    expect(doc).toContain(`| ${PLAN_COLUMNS_FULL.join(" | ")} |`);
  });

  it("the documented status list and the ready rule's excluded set match the plan.mjs constants", () => {
    const statusRow = /^\| `status` \| (.+) \|$/m.exec(doc)?.[1] ?? "";
    expect([...statusRow.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort()).toEqual([...STATUSES].sort());
    const excluded = /`status ∉ \{([^}]+)\}`/.exec(doc)?.[1] ?? "";
    expect(excluded.split(",").map((s) => s.trim()).sort()).toEqual([...NOT_READY].sort());
  });
});

// The story map is product state: `pnpm trace story-lint` must pass on what is committed, and
// story-map.mjs must read the same statuses, in the same order, as implementation-status.md's
// status model (the order is the evidence ladder its "or higher" rules climb). An adopter
// without a story map passes the lint vacuously, so the legend check skips without one.
describe("committed story map ↔ story-map.mjs", () => {
  const file = (rel) => ({ path: rel, text: existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null });
  const dashboard = join(ROOT, STORY_MAP_PATHS.dashboard);

  it("the committed story map and store pass story-lint with no errors", () => {
    const dir = join(ROOT, STORY_MAP_PATHS.stories);
    const stories = existsSync(dir) ? readdirSync(dir).filter((f) => /^US-.*\.md$/.test(f)).sort().map((f) => file(`${STORY_MAP_PATHS.stories}/${f}`)) : [];
    const map = { stories, index: file(STORY_MAP_PATHS.index), dashboard: file(STORY_MAP_PATHS.dashboard), log: file(STORY_MAP_PATHS.log), coverage: file(STORY_MAP_PATHS.coverage) };
    const state = replay(loadEntries(DEFAULT_STORE), schema, readPolicyVersion());
    // As in the CLI: a cited spec counts only as a regular file inside the repo, not one that climbs out with ../.
    const specExists = (p) => {
      const abs = join(ROOT, p);
      return abs.startsWith(ROOT + sep) && existsSync(abs) && statSync(abs).isFile();
    };
    expect(storyMapViolations(map, state, { specExists }).errors).toEqual([]);
  });

  it.skipIf(!existsSync(dashboard))("the status model lists STORY_STATUSES, in order", () => {
    const doc = readFileSync(dashboard, "utf8");
    const at = doc.search(/^## Status model$/m);
    expect(at).toBeGreaterThan(-1);
    expect([...doc.slice(at).matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1])).toEqual(STORY_STATUSES);
  });
});

// Bench agents run `pnpm test` in this repo, so nothing here may PRINT ground truth:
// no fixture id or defect text in test names or assertion messages (opaque tokens and
// counts only). A leak via a failing test title contaminated the second bench run.
describe("TRACE-Bench-lite fixtures", () => {
  const manifest = readBench();
  const { hitsDenylist, parseDiffPaths } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist", "parseDiffPaths"]);

  it("the bundle decodes to a structurally valid manifest and re-encodes byte-identically", () => {
    expect(manifestViolations(manifest).length).toBe(0); // count only — messages name fixture ids
    expect(encodeBench(manifest)).toBe(readFileSync(BENCH_BUNDLE, "utf8"));
  });

  it("no ground truth is readable as plain text anywhere in the tree (bench agents grep it)", () => {
    const { markers, files } = leakyFiles(manifest);
    expect(markers).toBeGreaterThan(manifest.fixtures.length); // patch-only tokens are included
    expect(files).toEqual([]); // files only, never the marker
  });

  // Whether each patch still APPLIES is deliberately not checked here: product edits near
  // a fixture hunk would turn `pnpm test` red for unrelated work. `pnpm trace bench-args`
  // and `bench-judge` refuse to run on stale fixtures instead.

  it("bench args leak no ground truth to the agents (ids, class, defect, judge)", () => {
    const args = benchArgs(manifest, {});
    const text = JSON.stringify(args);
    const leaked = manifest.fixtures.filter((f) => text.includes(f.id) || (f.defect && text.includes(f.defect)));
    expect(leaked.map((f) => opaqueFixtureId(f.id))).toEqual([]);
    expect(args.fixtures.every((f) => /^fx-[0-9a-f]{8}$/.test(f.id))).toBe(true);
    expect(text).not.toMatch(/"kind"|"defect"|"judge"|"lenses"/);
  });

  it("scoring maps opaque tokens back, and excludes runs whose transcript leaked ground truth (F0)", () => {
    const [b] = manifest.fixtures.filter((f) => f.kind === "bad");
    const token = opaqueFixtureId(b.id);
    const runs = [{ arm: "verifier", repeat: 0, fixtureId: token, verdict: "accept", preGateVerdict: "accept" }];
    expect(scoreBench(manifest, { runs }).arms.verifier.wrongAcceptRate).toBe(1);
    const keys = contaminatedRuns([{ label: `bench-verify:${token}-r0-0`, text: `... read ${b.id} ...` }, { label: `bench-verify:${token}-r1-0`, text: "clean" }], manifest);
    expect(keys.length === 1 && keys[0].arm === "verifier" && keys[0].token === token && keys[0].repeat === 0).toBe(true);
    const s = scoreBench(manifest, { runs: markContaminated(runs, keys) });
    expect(s.contaminatedRuns).toBe(1);
    expect(s.arms.verifier).toBeUndefined();
    expect(s.flags.some((f) => f.startsWith("F0"))).toBe(true);
  });

  it("denylist judges agree with the production denylist, and good fixtures never hit it", () => {
    const wrong = manifest.fixtures.filter((f) => {
      const hit = hitsDenylist(parseDiffPaths(f.patch));
      return (f.judge.kind === "denylist" && hit !== f.judge.catches) || (f.kind === "good" && hit);
    });
    expect(wrong.map((f) => opaqueFixtureId(f.id))).toEqual([]);
  });
});

describe("verdict-reuse input contract", () => {
  it("`query --brief` carries every field critic-panel reads from a prior record", () => {
    const text = readFileSync(join(ROOT, ".claude/workflows/critic-panel.js"), "utf8");
    const reads = new Set([...text.matchAll(/\bprior\.([a-z_]+)/g)].map((m) => m[1]));
    const digest = /const priorDigest[\s\S]*?\n {2}: ''/.exec(text)[0];
    for (const m of digest.matchAll(/\b[rxy]\.([a-z_]+)/g)) reads.add(m[1]); // the digest's map (r) and sort (x, y)
    expect(reads.size).toBeGreaterThan(5);
    // completion reads these from each prior of a lens the round did not review (an open
    // prior blocker keeps it at defer); if the scan above stops seeing them, fail here.
    expect([...reads]).toEqual(expect.arrayContaining(["severity", "cleared"]));
    const keys = Object.keys(briefRecords([{ record_id: "TR-x", provenance: {} }])[0]);
    expect([...reads].filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("`query --brief` carries the severity, and marks a record cleared only when a CLEAR action names it", () => {
    const recs = [
      { record_id: "TR-a", severity: "blocker", provenance: {}, created_at: "2026-10-07T12:00:02.000Z" },
      { record_id: "TR-b", provenance: {}, created_at: "2026-10-07T12:00:01.000Z" },
    ];
    const actions = [{ record_id: "TR-a", action: "CLEAR" }, { record_id: "TR-b", action: "HOLD" }];
    expect(briefRecords(recs, actions).map((r) => [r.record_id, r.severity, r.cleared])).toEqual([["TR-a", "blocker", true], ["TR-b", "", false]]);
    expect(briefRecords(recs).map((r) => r.cleared)).toEqual([false, false]); // no actions given: nothing is cleared (fail closed)
  });
});

// A critic round is clean only when its computed completion verdict is `accept`; every
// consumer that gates on a round must say so, not re-derive "clean" from empty lists.
describe("round-integrity consumers", () => {
  it.each([
    ".claude/commands/critic-round.md",
    ".claude/commands/multi-agent-dev.md",
    ".claude/commands/qa-pass.md",
    ".claude/loop.md",
    ".claude/commands/scan-project-docs.md",
    ".claude/commands/sync-story-status.md",
    ".claude/commands/multi-agent-e2e.md", // its post-implementation round over the new specs
  ])("%s gates on completion.verdict", (rel) => {
    expect(readFileSync(join(ROOT, rel), "utf8")).toContain("completion.verdict");
  });
});

// The <agent-safety> block bars every critic-panel agent from running E2E anywhere and from
// building in the shared checkout, so a round with UI or perf lenses in scope sees those results
// only when its caller runs them first and passes the output as priorEvidence. (/qa-pass already
// passes its own build and E2E results.)
describe("Lead-supplied evidence for critic rounds", () => {
  const count = (text, s) => text.split(s).length - 1;
  it.each([
    [".claude/commands/critic-round.md", 1],
    [".claude/commands/multi-agent-dev.md", 2], // the pre- and the post-implementation round
    [".claude/loop.md", 1],
    [".claude/commands/scan-project-docs.md", 1],
    [".claude/commands/sync-story-status.md", 1],
  ])("%s has the Lead run E2E (with axe) and the bundle check first and pass them as priorEvidence", (rel, rounds) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const anchor of ["pnpm test:e2e", "e2e/a11y.spec.ts", "pnpm build && pnpm check:bundle"]) {
      expect(count(text, anchor), anchor).toBeGreaterThanOrEqual(rounds);
    }
    expect(text).toContain("priorEvidence");
  });
});
