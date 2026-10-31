// The sanctioned writer is the CLI, so test it as a process: exit codes, fail-closed
// paths, and the bench-judge safety helpers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_STORE, encodeBench, latestByClaim, loadEntries, loadSchema, opaqueFixtureId, readBench, readPolicyVersion, replay, ROOT } from "./lib.mjs";
import { appliedFixtures, benchPreconditionStep, benchPreflight, judgeEnv, runBenchJudge, runJudge, SIGNALS } from "./bench-judge.mjs";
import { DEFAULT_PLAN, parsePlan, readyIds } from "./plan.mjs";
import { STORY_MAP_PATHS } from "./story-map.mjs";

const CLI = join(ROOT, "scripts/trace/cli.mjs");
let dir;
let store;
const trace = (args, input) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", input, env: { ...process.env, TRACE_STORE: store } });
const draft = (over = {}) =>
  JSON.stringify({
    writer_id: "test",
    claim_id: "cli:demo",
    claim_text: "demo claim",
    claim_type: "factual",
    evidence: [{ kind: "command", ref: "echo ok", result: "ok" }],
    final_status: "accept",
    reason: "checked",
    provenance: { workflow: "test" },
    ...over,
  });
// The sha256 of the production <loop-verifier> block (marker lines included), computed here
// independently of lib.mjs, and a bench record draft that names it (override any field). By
// default its verifier arm measured the whole (2 bad / 2 good) manifest.
const verifierSha = (text) => createHash("sha256").update(/\/\/ <loop-verifier>\n[\s\S]*?\/\/ <\/loop-verifier>\n/.exec(text)[0]).digest("hex");
const CURRENT_VERIFIER = verifierSha(readFileSync(join(ROOT, ".claude/workflows/loop-iteration.js"), "utf8"));
const benchDraft = ({ status = "accept", repeats = 2, gates = ["F2 (informational)"], hash = CURRENT_VERIFIER, measured = { bad: 2, good: 2 } } = {}) =>
  JSON.stringify({
    writer_id: "trace-bench/score",
    claim_id: "bench:trace-bench-lite",
    claim_text: `TRACE-Bench-lite (2 bad / 2 good fixtures): ${status} at ${repeats} repeat(s)`,
    claim_type: "measured",
    evidence: [
      { kind: "measurement", ref: "pnpm trace bench-score runs.json [runs 0a1b2c3d]", result: JSON.stringify({ fixtures: { bad: 2, good: 2 }, arms: { verifier: { repeats, measured } } }) },
      { kind: "file_line", ref: ".claude/workflows/loop-iteration.js", result: `<loop-verifier> sha256=${hash}` },
    ],
    failed_gates: gates,
    missing: [],
    final_status: status,
    ...(status === "qualify" ? { qualifier: "measured on the clean runs only — 1 contaminated run(s) were excluded" } : {}),
    reason: "deterministic scoring of the raw bench runs",
    provenance: { workflow: "trace-bench" },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  store = join(dir, "records.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pnpm trace (CLI process)", () => {
  it("write stores a valid draft and stamps a real commit; a repeated write is refused", () => {
    const first = trace(["write", "-"], draft());
    expect(first.status).toBe(0);
    const [res] = JSON.parse(first.stdout);
    expect(res.stored).toBe(true);
    expect(JSON.parse(readFileSync(store, "utf8").trim()).provenance.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(trace(["write", "-"], draft()).status).toBe(1);
  });

  it("act fails closed: CLEAR on a defer exits 1, HOLD exits 0", () => {
    trace(["write", "-"], draft({ final_status: "defer", missing: ["a measurement"], evidence: [] }));
    const id = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    expect(trace(["act", id, "loop", "CLEAR"]).status).toBe(1);
    expect(trace(["act", id, "loop", "HOLD", "--ref", "LP-001"]).status).toBe(0);
    expect(trace(["lint"]).status).toBe(0);
  });

  it("write --then-act records the consumer decision on every stored record", () => {
    const two = `[${draft()},${draft({ claim_id: "cli:other", claim_text: "other claim" })}]`;
    const out = trace(["write", "-", "--then-act", "HOLD", "--consumer", "critic-round", "--note", "review-only round"], two);
    expect(out.status).toBe(0);
    const ids = JSON.parse(trace(["query", "--json"]).stdout).map((r) => r.record_id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(JSON.parse(trace(["show", id]).stdout).actions[0]).toMatchObject({ action: "HOLD", consumer: "critic-round" });
  });

  it("the documented hand-off works: a critic-panel-shaped result file → write <file> → act --from <file>", () => {
    trace(["write", "-"], draft({ claim_id: "cli:prior" }));
    const priorId = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    const file = join(dir, "result.json");
    writeFileSync(file, JSON.stringify({ confirmed: [], traceRecords: [JSON.parse(draft({ claim_id: "cli:new" }))], reuseActions: [{ record_id: priorId, consumer: "critic-panel", action: "REUSE", note: "still present" }] }));
    expect(trace(["write", file]).status).toBe(0);
    expect(trace(["act", "--from", file]).status).toBe(0);
    expect(trace(["act", "--from", file]).status).toBe(0); // a later REUSE event is stored again
    expect(JSON.parse(trace(["show", priorId]).stdout).actions).toHaveLength(2);
    expect(trace(["lint"]).status).toBe(0);
  });

  it("act --from with no recognizable actions fails instead of silently writing nothing", () => {
    const file = join(dir, "empty.json");
    writeFileSync(file, JSON.stringify({ something: [] }));
    expect(trace(["act", "--from", file]).status).toBe(1);
  });

  it("lint exits 1 on a tampered store", () => {
    trace(["write", "-"], draft());
    writeFileSync(store, readFileSync(store, "utf8").replace("demo claim", "other claim"));
    expect(trace(["lint"]).status).toBe(1);
  });

  it("refuses a draft carrying bench ground truth (fixture ids come from the encoded bundle)", async () => {
    const { readBench } = await import("./lib.mjs");
    const leaky = readBench().fixtures[0].id;
    const out = trace(["write", "-"], draft({ claim_text: `about ${leaky}` }));
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/bench ground truth/);
    expect(out.stdout.includes(leaky)).toBe(false); // boolean: a failure must not print the id
  });

  it("tree-id prints a 16-hex fingerprint", () => {
    const out = trace(["tree-id"]);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("bench-score --record refuses to record an unscanned run", () => {
    const runs = join(dir, "runs.json");
    writeFileSync(runs, JSON.stringify({ runs: [] }));
    const out = trace(["bench-score", runs, "--record"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/--transcripts/);
  });
});

/** Write one draft through the CLI (its gates apply) and return the stored record's id. */
const writeOne = (over) => {
  const out = trace(["write", "-"], draft(over));
  expect(out.status, out.stdout).toBe(0);
  return JSON.parse(out.stdout)[0].record_id;
};

// The memory write boundary follows the commit, not the claim id: only a wiki: record is COMMITted to a topic page or
// QUARANTINEd. The writer refuses the rest at append time; a COMMIT that names no page (a story status) still works.
describe("act: the memory write boundary follows the commit (CLI process)", () => {
  const PAGE_REFS = ["topics/x.md", "./topics/x.md", ".claude/memory/topics/x.md"];

  it("refuses a COMMIT or COMMIT_QUALIFIED to a topic page (however the ref is written) and a QUARANTINE on a non-wiki: record, naming the fix and storing nothing", () => {
    const memo = writeOne({ claim_id: "memo:x", claim_text: "a memo" });
    const memoQ = writeOne({ claim_id: "memo:q", claim_text: "a qualified memo", final_status: "qualify", qualifier: "on one run" });
    const memoD = writeOne({ claim_id: "memo:d", claim_text: "a deferred memo", final_status: "defer", missing: ["a reproduction"], evidence: [] });
    const refused = [...PAGE_REFS.map((ref) => [memo, "COMMIT", ref]), [memoQ, "COMMIT_QUALIFIED", "topics/x.md"], [memoD, "QUARANTINE", "quarantine.md"]];
    for (const [id, action, ref] of refused) {
      const out = trace(["act", id, "dream", action, "--ref", ref]);
      expect(out.status, `${action} --ref ${ref}`).toBe(1);
      const [res] = JSON.parse(out.stdout);
      expect(res.stored).toBe(false);
      expect(res.validation.fail.join("\n"), `${action} --ref ${ref}`).toMatch(/is not a wiki: record — .*re-admit the fact through \/dream as wiki:<topic>:<slug>/);
    }
    expect(readFileSync(store, "utf8").trim().split("\n")).toHaveLength(3); // the three records, no action
  });

  it("stores a story-status COMMIT --ref US-001 on a non-wiki: record, and on wiki: records every one of those actions", () => {
    const story = writeOne({ writer_id: "scan-docs", claim_id: "story:us-001:status", claim_text: "US-001 is Implemented" });
    expect(trace(["act", story, "story-status", "COMMIT", "--ref", "US-001"]).status).toBe(0);
    const fact = writeOne({ writer_id: "dream", claim_id: "wiki:testing:x", claim_text: "a fact" });
    const factQ = writeOne({ writer_id: "dream", claim_id: "wiki:testing:q", claim_text: "a qualified fact", final_status: "qualify", qualifier: "on one run" });
    const candidate = writeOne({ writer_id: "dream", claim_id: "wiki:testing:d", claim_text: "a candidate", final_status: "defer", missing: ["a reproduction"], evidence: [] });
    for (const ref of PAGE_REFS) expect(trace(["act", fact, "dream", "COMMIT", "--ref", ref]).status, ref).toBe(0);
    expect(trace(["act", factQ, "dream", "COMMIT_QUALIFIED", "--ref", "topics/x.md"]).status).toBe(0);
    expect(trace(["act", candidate, "dream", "QUARANTINE", "--ref", "quarantine.md"]).status).toBe(0);
    const actions = readFileSync(store, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "action");
    expect(actions.map((a) => `${a.action} ${a.ref}`)).toEqual(["COMMIT US-001", ...PAGE_REFS.map((ref) => `COMMIT ${ref}`), "COMMIT_QUALIFIED topics/x.md", "QUARANTINE quarantine.md"]);
    expect(trace(["lint"]).status).toBe(0);
  });
});

// The whole-store open-blocker check (critic-round.md, multi-agent-dev.md) asks one question; --severity keeps its
// answer to the blocker records instead of every latest critic record.
describe("query --severity (CLI process)", () => {
  const OPEN_BLOCKER_CHECK = "pnpm -s trace query --latest --writer critic-panel --severity blocker --json";
  const critic = (claim, over = {}) => ({ writer_id: `critic-panel/verify:${claim}-0`, claim_id: `critic:${claim}`, claim_text: claim, provenance: { workflow: "critic-panel" }, ...over });
  const ids = (...args) => {
    const out = trace(["query", ...args, "--json"]);
    expect(out.status, args.join(" ")).toBe(0);
    return JSON.parse(out.stdout).map((r) => r.record_id);
  };

  it("is an exact match on a record's severity and composes with --latest and --writer; the documented open-blocker check is exactly that query", () => {
    const rerated = writeOne(critic("a11y:rerated", { severity: "blocker" }));
    const deferred = writeOne(critic("ux:deferred", { severity: "blocker", final_status: "defer", missing: ["a browser repro"], evidence: [] }));
    const important = writeOne(critic("perf:important", { severity: "important" }));
    const loopBlocker = writeOne({ writer_id: "loop-iteration/verify:LP-001-0", claim_id: "loop:lp-001", claim_text: "a loop finding", severity: "blocker" });
    writeOne(critic("qa:unrated")); // no severity: never matched
    const nowImportant = writeOne(critic("a11y:rerated", { severity: "important", claim_text: "a11y:rerated, re-rated", revises: rerated }));
    expect(ids("--severity", "blocker")).toEqual([rerated, deferred, loopBlocker]);
    expect(ids("--severity", "important")).toEqual([important, nowImportant]);
    expect(ids("--latest", "--severity", "blocker")).toEqual([deferred, loopBlocker]); // the re-rated claim's latest record is important
    expect(ids("--writer", "critic-panel", "--severity", "blocker")).toEqual([rerated, deferred]);
    const documented = OPEN_BLOCKER_CHECK.split(" ").slice(4, -1); // the flags between `query` and `--json`
    expect(ids(...documented)).toEqual([deferred]);
    for (const doc of [".claude/commands/critic-round.md", ".claude/commands/multi-agent-dev.md"]) {
      expect(readFileSync(join(ROOT, doc), "utf8"), doc).toContain(OPEN_BLOCKER_CHECK);
    }
  });

  it("a missing or unknown value is a usage error (exit 2), never an empty list that would read as 'no open blocker'", () => {
    writeOne(critic("a11y:x", { severity: "blocker" }));
    for (const bad of [["--severity"], ["--severity", "blockers"], ["--severity", "Blocker"], ["--severity", "--json"]]) {
      const out = trace(["query", ...bad]);
      expect(out.status, bad.join(" ")).toBe(2);
      expect(out.stdout, bad.join(" ")).toMatch(/--severity blocker\|important\|nice-to-have/);
    }
  });
});

// The loop plan's DAG commands, run as a process on a temp --plan (and the temp store).
describe("plan commands (CLI process)", () => {
  const HEADER = "| id | description | after | status | record | missing | origin | notes |\n|---|---|---|---|---|---|---|---|";
  let plans = 0;
  const writePlan = (...rows) => {
    const p = join(dir, `loop-plan-${(plans += 1)}.md`);
    writeFileSync(p, `# Loop Plan\n\n## Plan\n\n${HEADER}\n${rows.join("\n")}\n`);
    return p;
  };

  it("plan-ready reads the committed plan by default (the ids readyIds computes from it), prints the ready ids of a temp --plan in table order (--max N keeps the first N), and fails closed on a table that does not parse", () => {
    // The committed plan is loop state (loop.md step 9 writes nodes into it): compare, never pin it.
    const head = trace(["plan-ready"]);
    expect(head.status).toBe(0);
    expect(JSON.parse(head.stdout)).toEqual(readyIds(parsePlan(readFileSync(DEFAULT_PLAN, "utf8")).nodes));
    const p = writePlan(
      "| LP-003 | third | — | ready | | | human | |",
      "| LP-001 | first | — | done | | | human | |",
      "| LP-002 | second | LP-001 | blocked | | | human | |",
      "| LP-004 | fourth | LP-003 | blocked | | | human | |",
    );
    const out = trace(["plan-ready", "--plan", p]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(["LP-003", "LP-002"]);
    expect(JSON.parse(trace(["plan-ready", "--max", "1", "--plan", p]).stdout)).toEqual(["LP-003"]);
    expect(JSON.parse(trace(["plan-ready", "--json", "--plan", p]).stdout).map((n) => [n.id, n.description])).toEqual([["LP-003", "third"], ["LP-002", "second"]]);
    const bad = trace(["plan-ready", "--plan", writePlan("| LP-001 | first | ready |")]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe(""); // no ids
    expect(bad.stderr).toMatch(/\[cells\]/);
    expect(trace(["plan-ready", "--plan", join(dir, "missing.md")]).status).toBe(1);
    expect(trace(["plan-ready", "--max", "0", "--plan", p]).status).toBe(2);
  });

  it("plan-lint exits 1 naming the rule when a done node cites a defer record, 0 on a consistent plan, and 2 when the store does not replay", () => {
    expect(trace(["write", "-"], draft({ writer_id: "loop-iteration/verify:LP-001-0", claim_id: "loop:lp-001", claim_type: "practical", final_status: "defer", missing: ["a unit test run"], evidence: [] })).status).toBe(0);
    const id = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    const done = trace(["plan-lint", "--plan", writePlan(`| LP-001 | first | — | done | ${id} | — | human | |`)]);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/\[done-record\] LP-001/);
    expect(trace(["act", id, "loop", "HOLD", "--ref", "LP-001"]).status).toBe(0);
    const ok = writePlan(`| LP-001 | first | — | deferred | ${id} | a unit test run | human | attempt 1 |`);
    const clean = trace(["plan-lint", "--pre-dispatch", "--plan", ok]);
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, errors: 0, nodes: 1 });
    const inflight = writePlan("| LP-002 | second | — | in-progress | | | human | |");
    expect(trace(["plan-lint", "--plan", inflight]).status).toBe(0); // the contract test can run mid-loop
    expect(trace(["plan-lint", "--pre-dispatch", "--plan", inflight]).status).toBe(1);
    writeFileSync(store, `${readFileSync(store, "utf8")}not json\n`);
    expect(trace(["plan-lint", "--plan", ok]).status).toBe(2);
  });

  it("plan-items prints loop-iteration items for ready ids and refuses a non-ready id with exit 1 (no items)", () => {
    const p = writePlan("| LP-001 | first fix | — | ready | | | human | n |", "| LP-002 | second | LP-001 | blocked | | | human | |");
    const out = trace(["plan-items", "LP-001", "--plan", p]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([{ id: "LP-001", description: "first fix" }]);
    const refused = trace(["plan-items", "LP-001", "LP-002", "--plan", p]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/LP-002/);
    expect(trace(["plan-items", "--plan", p]).status).toBe(2);
  });

  it("plan-items replays the store: priorRecordId is the node's own loop:<id> record only (never a critic record), and a store that does not replay exits 2 with no items", () => {
    expect(trace(["write", "-"], draft({ writer_id: "loop-iteration/verify:LP-003-0", claim_id: "loop:lp-003", claim_type: "practical", final_status: "defer", missing: ["a unit test run"], evidence: [] })).status).toBe(0);
    expect(trace(["write", "-"], draft({ writer_id: "critic-panel/verify:qa-e2e-0", claim_id: "critic:qa-e2e:untested", final_status: "defer", missing: ["an E2E run"], evidence: [] })).status).toBe(0);
    const [own, critic] = JSON.parse(trace(["query", "--json"]).stdout).map((r) => r.record_id);
    const reset = writePlan(`| LP-003 | third | — | ready | ${own} | a unit test run | human | |`, `| LP-004 | fourth | — | ready | ${critic} | an E2E run | critic rec:${critic} | |`);
    const items = trace(["plan-items", "LP-003", "LP-004", "--plan", reset]);
    expect(items.status).toBe(0);
    expect(JSON.parse(items.stdout)).toEqual([
      { id: "LP-003", description: "third", priorRecordId: own, missing: "a unit test run" },
      { id: "LP-004", description: "fourth", missing: "an E2E run" },
    ]);
    writeFileSync(store, `${readFileSync(store, "utf8")}not json\n`);
    const broken = trace(["plan-items", "LP-003", "--plan", reset]);
    expect(broken.status).toBe(2);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toMatch(/does not replay/);
  });
});

// story-lint reads a cited spec on disk (cli.mjs): it counts only as a regular file. The other story-lint
// process tests, with their synthetic story-map builder, are in story-map.test.mjs.
describe("story-lint: a cited spec is a regular file (CLI process)", () => {
  it("a coverage row citing the directory e2e/, or a directory named like a spec file, fails rule (4)", () => {
    const root = join(dir, "checkout");
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const table = (head, rows) => `| ${head.join(" | ")} |\n|${head.map(() => "---|").join("")}\n${rows.join("\n")}\n`;
    const ids = ["US-001", "US-002", "US-003"];
    for (const id of ids) put(`${STORY_MAP_PATHS.stories}/${id}-story.md`, `# ${id}: A story\n\n**Final status:**\nE2E tested\nRecord: (pre-TRACE)\n`);
    put(STORY_MAP_PATHS.index, table(["ID", "Status"], ids.map((id) => `| ${id} | E2E tested |`)));
    put(STORY_MAP_PATHS.dashboard, table(["Story", "Final status"], ids.map((id) => `| ${id} | E2E tested |`)));
    put(STORY_MAP_PATHS.log, table(["Story ID", "Check performed"], [`| ${ids.join(", ")} | Unit tests |`]));
    put(STORY_MAP_PATHS.coverage, table(["Story ID", "E2E test file"], ["| US-001 | `e2e/` |", "| US-002 | `e2e/flows.spec.ts` |", "| US-003 | `e2e/a.spec.ts` |"]));
    put("e2e/a.spec.ts", "// a spec\n");
    put("e2e/flows.spec.ts/a.spec.ts", "// a spec inside a directory named like one\n");
    const res = trace(["story-lint", "--root", root]);
    const errors = res.stderr.split("\n").filter((l) => l.startsWith("error: "));
    expect(errors.map((l) => /^error: \[([a-z0-9-]+)\] (US-\d+)/.exec(l)?.slice(1).join(" "))).toEqual(["e2e-coverage US-001", "e2e-coverage US-002"]);
    expect(errors[1]).toMatch(/e2e\/flows\.spec\.ts \(line \d+\) is not a file in the repo$/);
    expect(res.status).toBe(1);
  });
});

describe("bench-judge safety helpers", () => {
  it("judges run with an allowlisted environment — no tokens or proxy credentials", () => {
    const env = judgeEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y", HTTPS_PROXY: "z" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", CI: "true" });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["GITHUB_TOKEN"]));
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("a judge that could not run is 'not observed', never 'caught'", async () => {
    expect(await runJudge("x", { spawn: () => ({ error: new Error("ENOENT"), status: null }) })).toBeNull();
    expect(await runJudge("x", { spawn: () => ({ status: null, signal: "SIGTERM" }) })).toBeNull();
    expect(await runJudge("x", { spawn: () => ({ status: 1 }) })).toBe(true);
    expect(await runJudge("x", { spawn: () => Promise.resolve({ status: 0 }) })).toBe(false);
  });

  // A synthetic fixture that creates a throwaway untracked file — safe to apply in the
  // real tree while other test files run (nothing reads it).
  const tmpName = `scripts/trace/.bench-judge-test-${process.pid}.txt`;
  const newFilePatch = `diff --git a/${tmpName} b/${tmpName}\nnew file mode 100644\n--- /dev/null\n+++ b/${tmpName}\n@@ -0,0 +1 @@\n+temporary\n`;
  const fx = (over = {}) => ({ id: "B90-synthetic", kind: "bad", patch: newFilePatch, judge: { kind: "command", command: "fake-judge", catches: true }, ...over });
  const quiet = { log: () => {}, applied: () => [] };

  it("runBenchJudge aborts when the judge already fails on the clean tree (baseline)", async () => {
    await expect(runBenchJudge({ fixtures: [fx()] }, { ...quiet, judge: async () => true })).rejects.toThrow(/baseline failed/);
  });

  it("runBenchJudge aborts when the baseline judge did not run at all (a timeout is not a pass)", async () => {
    await expect(runBenchJudge({ fixtures: [fx()] }, { ...quiet, judge: async () => null })).rejects.toThrow(/did not run/);
  });

  it("runBenchJudge: a judge that did not run is ok:false, and the patch is reversed", async () => {
    let calls = 0;
    const res = await runBenchJudge({ fixtures: [fx()] }, { ...quiet, judge: async () => (calls++ === 0 ? false : null) });
    expect(res[0]).toMatchObject({ observed: null, ok: false });
    expect(spawnSync("git", ["status", "--porcelain", "--", tmpName], { cwd: ROOT, encoding: "utf8" }).stdout).toBe("");
  });

  it("runBenchJudge: an interrupt stops the run after restoring the tree", async () => {
    let calls = 0;
    const judge = async () => {
      calls += 1;
      if (calls === 2) process.emit("SIGUSR2", "SIGUSR2"); // during the first fixture
      return calls === 1 ? false : true;
    };
    await expect(runBenchJudge({ fixtures: [fx(), fx({ id: "B91-synthetic" })] }, { ...quiet, judge, signals: ["SIGUSR2"] })).rejects.toThrow(/interrupted/);
    expect(calls).toBe(2); // the second fixture never ran
    expect(spawnSync("git", ["status", "--porcelain", "--", tmpName], { cwd: ROOT, encoding: "utf8" }).stdout).toBe("");
  });

  it("runBenchJudge refuses to start while a fixture patch is still applied (killed run)", async () => {
    await expect(runBenchJudge({ fixtures: [fx()] }, { log: () => {}, judge: async () => false, applied: (m) => m.fixtures })).rejects.toThrow(/--recover/);
  });

  it("preflight: a fixture patch left applied is reported as applied (not stale), and --recover reverses it", () => {
    const m = { fixtures: [fx()] };
    expect(benchPreflight(m)).toEqual({});
    expect(spawnSync("git", ["apply", "-"], { cwd: ROOT, input: newFilePatch }).status).toBe(0);
    try {
      const pre = benchPreflight(m);
      expect(pre.error).toMatch(/--recover/);
      expect(pre.stale).toBeUndefined();
      expect(benchPreflight(m, { recover: true }).reversed).toEqual([opaqueFixtureId("B90-synthetic")]);
      expect(existsSync(join(ROOT, tmpName))).toBe(false);
    } finally {
      rmSync(join(ROOT, tmpName), { force: true });
    }
  });

  it("a fixture whose change is already COMMITTED (clean files) is not 'applied' — --recover must never revert committed code", () => {
    const [l1, l2, l3] = readFileSync(join(ROOT, "README.md"), "utf8").split("\n");
    const patch = `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n+${l1}\n ${l2}\n ${l3}\n`;
    expect(spawnSync("git", ["apply", "-R", "--check", "-"], { cwd: ROOT, input: patch }).status).toBe(0); // it does reverse cleanly…
    expect(appliedFixtures({ fixtures: [fx({ patch })] })).toEqual([]); // …but nothing is uncommitted, so it was not left by a run
    // …and even with an unrelated uncommitted edit in the same file, HEAD already contains it.
    expect(appliedFixtures({ fixtures: [fx({ patch })] }, { dirty: () => true })).toEqual([]);
  });

  it("a fixture patch left applied (uncommitted, not in HEAD) is detected; one HEAD contains is not", () => {
    const m = { fixtures: [fx()] };
    expect(spawnSync("git", ["apply", "-"], { cwd: ROOT, input: newFilePatch }).status).toBe(0);
    try {
      expect(appliedFixtures(m).map((f) => f.id)).toEqual(["B90-synthetic"]);
      expect(appliedFixtures(m, { inHead: () => true })).toEqual([]);
    } finally {
      rmSync(join(ROOT, tmpName), { force: true });
    }
  });

  it("preflight: a patch that neither applies nor is applied is stale (and --recover says so instead of exiting ok)", () => {
    const gone = `scripts/trace/.bench-judge-missing-${process.pid}.txt`;
    const patch = `diff --git a/${gone} b/${gone}\n--- a/${gone}\n+++ b/${gone}\n@@ -1 +1 @@\n-x\n+y\n`;
    expect(benchPreflight({ fixtures: [fx({ patch })] }).stale).toHaveLength(1);
    expect(benchPreflight({ fixtures: [fx({ patch })] }, { recover: true })).toMatchObject({ reversed: [], stale: [expect.any(String)] });
  });

  // Never run `bench-judge --recover` against the real manifest here: it would reverse a
  // fixture patch an in-flight bench-judge run has applied. The CLI delegates its whole
  // precondition step (flag wiring + exit codes) to benchPreconditionStep.
  it("the CLI precondition step: --recover only for bench-judge, exit 1 while anything is still applied or stale", () => {
    const m = { fixtures: [fx()] };
    expect(benchPreconditionStep("bench-args", {}, m)).toBeNull();
    expect(spawnSync("git", ["apply", "-"], { cwd: ROOT, input: newFilePatch }).status).toBe(0);
    try {
      const args = benchPreconditionStep("bench-args", { recover: true }, m); // bench-args never recovers
      expect(args.code).toBe(1);
      expect(args.body.applied).toEqual([opaqueFixtureId("B90-synthetic")]); // opaque tokens only
      expect(benchPreconditionStep("bench-judge", { recover: true }, m)).toEqual({ code: 0, body: { reversed: [opaqueFixtureId("B90-synthetic")] } });
      expect(existsSync(join(ROOT, tmpName))).toBe(false);
    } finally {
      rmSync(join(ROOT, tmpName), { force: true });
    }
    const gone = `scripts/trace/.bench-judge-missing-${process.pid}.txt`;
    const stale = { fixtures: [fx({ patch: `diff --git a/${gone} b/${gone}\n--- a/${gone}\n+++ b/${gone}\n@@ -1 +1 @@\n-x\n+y\n` })] };
    expect(benchPreconditionStep("bench-judge", { recover: true }, stale).code).toBe(1);
  });

  // A judge with a CHILD of its own (like `pnpm test:e2e` → its dev server): the kill must
  // reach the whole process group, not just the direct child.
  const judgeWithChild = () => {
    const d = mkdtempSync(join(tmpdir(), "trace-judge-"));
    const script = join(d, "judge.sh");
    const pidFile = join(d, "grandchild.pid");
    writeFileSync(script, `sleep 30 &\necho $! > ${pidFile}\nwait\n`);
    const grandchild = () => Number(readFileSync(pidFile, "utf8"));
    return { d, command: `sh ${script}`, grandchild, ready: () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "" };
  };
  // Gone, or a zombie waiting to be reaped (some containers never reap orphans). Without
  // /proc (macOS), ask the kernel directly — never default to "dead".
  const dead = (pid) => {
    if (existsSync("/proc/self/stat")) {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z");
      } catch {
        return true; // no /proc entry: the process is gone
      }
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  };
  const settle = async (pids) => {
    for (let i = 0; i < 40 && !pids.every(dead); i += 1) await new Promise((r) => setTimeout(r, 50));
    return pids.map(dead);
  };
  const waitFor = async (cond) => {
    for (let i = 0; i < 100 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 20));
  };

  it("a judge that outlives its timeout is killed WITH its children and counts as 'did not run'", async () => {
    const j = judgeWithChild();
    try {
      let child;
      const t0 = Date.now();
      // Busy-wait a few ms after spawn: if spawn's own `timeout` were forwarded, it would fire
      // in an earlier timer pass than ours, kill only the direct child, and the child's exit
      // would cancel our group kill — orphaning the grandchild.
      const onChild = (c) => {
        child = c;
        const until = Date.now() + 8;
        while (Date.now() < until);
      };
      expect(await runJudge(j.command, { timeoutMs: 400, onChild })).toBeNull();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(await settle([child.pid, j.grandchild()])).toEqual([true, true]);
    } finally {
      rmSync(j.d, { recursive: true, force: true });
    }
  });

  it("the default signal list covers Ctrl+C, kill and a closed terminal", () => {
    expect(SIGNALS).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM", "SIGHUP"]));
  });

  it("a REAL signal kills the running judge AND its children, stops the run and removes the handlers", async () => {
    const keep = () => {}; // guard: never let a stray SIGUSR2 hit the default (terminate) action
    process.on("SIGUSR2", keep);
    const before = process.listenerCount("SIGUSR2");
    const j = judgeWithChild();
    try {
      let child;
      const m = { fixtures: [fx({ judge: { kind: "command", command: j.command, catches: true } })] };
      const t0 = Date.now();
      const run = runBenchJudge(m, { log: () => {}, applied: () => [], signals: ["SIGUSR2"], onChild: (c) => (child = c) });
      await waitFor(j.ready);
      process.kill(process.pid, "SIGUSR2");
      await expect(run).rejects.toThrow(/interrupted/);
      expect(Date.now() - t0).toBeLessThan(10000);
      expect(await settle([child.pid, j.grandchild()])).toEqual([true, true]); // checked by pid, not a machine-wide scan
      expect(process.listenerCount("SIGUSR2")).toBe(before);
    } finally {
      process.off("SIGUSR2", keep);
      rmSync(j.d, { recursive: true, force: true });
    }
  });

  // Two synthetic new-file fixtures; their files are the only "touchable" paths.
  const other = `scripts/trace/.bench-judge-test-${process.pid}-b.txt`;
  const otherPatch = `diff --git a/${other} b/${other}\nnew file mode 100644\n--- /dev/null\n+++ b/${other}\n@@ -0,0 +1 @@\n+temporary\n`;
  const cleanup = () => [tmpName, other].forEach((p) => rmSync(join(ROOT, p), { force: true }));

  it("refuses to apply a fixture onto files with local changes, and leaves them untouched", async () => {
    writeFileSync(join(ROOT, tmpName), "mine\n");
    try {
      const res = await runBenchJudge({ fixtures: [fx()] }, { ...quiet, judge: async () => false });
      expect(res[0]).toMatchObject({ ok: false, observed: null });
      expect(res[0].note).toMatch(/refused: local changes/);
      expect(readFileSync(join(ROOT, tmpName), "utf8")).toBe("mine\n");
    } finally {
      cleanup();
    }
  });

  it("throws (pointing at --recover) when a fixture patch cannot be reversed after its judge ran", async () => {
    let calls = 0;
    const judge = async () => {
      calls += 1;
      if (calls === 2) writeFileSync(join(ROOT, tmpName), "changed by the judge\n"); // during the fixture
      return false;
    };
    try {
      await expect(runBenchJudge({ fixtures: [fx()] }, { ...quiet, judge })).rejects.toThrow(/could not reverse.*--recover/);
    } finally {
      cleanup();
    }
  });

  it("throws when the working tree changed during the run (end-of-run integrity check)", async () => {
    let calls = 0;
    const judge = async () => {
      calls += 1;
      if (calls === 2) writeFileSync(join(ROOT, other), "left behind\n"); // touches the other fixture's file
      return false;
    };
    const m = { fixtures: [fx(), fx({ id: "B91-synthetic", patch: otherPatch })] };
    try {
      await expect(runBenchJudge(m, { ...quiet, judge })).rejects.toThrow(/working tree changed/);
    } finally {
      cleanup();
    }
  });
});

describe("round-3 CLI fixes", () => {
  it("act --from a critic-panel result that reused nothing exits 0 (a recognised, empty list)", () => {
    const file = join(dir, "res.json");
    writeFileSync(file, JSON.stringify({ confirmed: [], traceRecords: [], reuseActions: [] }));
    expect(trace(["act", "--from", file]).status).toBe(0);
  });

  it("consumer-action notes are screened for bench ground truth at the CLI (act and write --then-act)", () => {
    const leaky = readBench().fixtures[0].id;
    trace(["write", "-"], draft());
    const id = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    const a = trace(["act", id, "loop", "HOLD", "--note", `see ${leaky}`]);
    expect(a.status).toBe(1);
    expect(a.stdout.includes(leaky)).toBe(false);
    expect(trace(["write", "-", "--then-act", "HOLD", "--consumer", "x", "--note", `see ${leaky}`], draft({ claim_id: "cli:other" })).status).toBe(1);
  });

  it("query --brief returns the newest window and keeps qualifiers", () => {
    const many = Array.from({ length: 41 }, (_, i) => JSON.parse(draft({ claim_id: `cli:b${i}`, claim_text: `claim ${i}`, final_status: "qualify", qualifier: `only case ${i}` })));
    expect(trace(["write", "-"], JSON.stringify(many)).status).toBe(0);
    const brief = JSON.parse(trace(["query", "--brief"]).stdout);
    expect(brief).toHaveLength(40);
    expect(brief.every((r) => r.qualifier.startsWith("only case"))).toBe(true);
  });

  it("query --brief carries each record's severity and marks it cleared only when a stored CLEAR action names it", () => {
    const two = `[${draft({ claim_id: "cli:blocker", claim_text: "a blocker", severity: "blocker" })},${draft({ claim_id: "cli:important", claim_text: "an important", severity: "important" })}]`;
    expect(trace(["write", "-"], two).status).toBe(0);
    const ids = Object.fromEntries(JSON.parse(trace(["query", "--json"]).stdout).map((r) => [r.claim_id, r.record_id]));
    expect(trace(["act", ids["cli:blocker"], "multi-agent-dev", "CLEAR"]).status).toBe(0);
    expect(trace(["act", ids["cli:important"], "critic-round", "HOLD"]).status).toBe(0);
    const brief = Object.fromEntries(JSON.parse(trace(["query", "--brief"]).stdout).map((r) => [r.claim_id, r]));
    expect(brief["cli:blocker"]).toMatchObject({ severity: "blocker", cleared: true });
    expect(brief["cli:important"]).toMatchObject({ severity: "important", cleared: false });
  });

  it("reaudit --act twice on an unchanged queue appends the REAUDIT once", () => {
    // deadbeef0000 is no commit of this repository: nothing can be diffed against it, so its note says so
    // (it used to read "evidence changed: package.json", a change nobody had observed).
    trace(["write", "-"], draft({ evidence: [{ kind: "file_line", ref: "package.json:1" }], provenance: { workflow: "test", commit: "deadbeef0000" } }));
    const lines = () => readFileSync(store, "utf8").trim().split("\n").length;
    expect(trace(["reaudit", "--act"]).status).toBe(0);
    expect(lines()).toBe(2);
    expect(trace(["reaudit", "--act"]).status).toBe(0);
    expect(lines()).toBe(2);
    expect(JSON.parse(readFileSync(store, "utf8").trim().split("\n")[1])).toMatchObject({ action: "REAUDIT", note: "provenance commit deadbeef0000 is unreachable — re-verify: package.json" });
  });

  it("act --from records BOTH actions and reuseActions when a result carries both", () => {
    trace(["write", "-"], draft());
    const id = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    const file = join(dir, "both.json");
    writeFileSync(file, JSON.stringify({ actions: [], reuseActions: [{ record_id: id, consumer: "critic-panel", action: "REUSE", note: "n" }] }));
    expect(trace(["act", "--from", file]).status).toBe(0);
    expect(JSON.parse(trace(["show", id]).stdout).actions).toHaveLength(1);
    writeFileSync(file, JSON.stringify({ actions: [{ record_id: id, consumer: "loop", action: "HOLD" }], reuseActions: [{ record_id: id, consumer: "critic-panel", action: "REUSE", note: "m" }] }));
    expect(trace(["act", "--from", file]).status).toBe(0);
    expect(JSON.parse(trace(["show", id]).stdout).actions.map((a) => a.action).sort()).toEqual(["HOLD", "REUSE", "REUSE"]);
  });

  it("bench-unpack refuses an in-repo directory (the guard is wired, not just the helper)", () => {
    const out = trace(["bench-unpack", `scripts/trace/.no-such-dir-${process.pid}`]);
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/refusing to unpack inside the repo/);
  });

  describe("denylist-check --patch (git's own parse, before applying)", () => {
    const clean = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";
    const check = (text) => {
      const p = join(dir, "x.patch");
      writeFileSync(p, text);
      return trace(["denylist-check", "--patch", p]);
    };
    it("passes a patch that touches no protected path", () => {
      expect(check(clean).status).toBe(0);
    });
    it("catches a mixed-format section with a non-a/b prefix", () => {
      const out = check(`${clean}--- c/.claude/memory/loop-plan.md\n+++ c/.claude/memory/loop-plan.md\n@@ -1 +1 @@\n-a\n+b\n`);
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).hits).toEqual([".claude/memory/loop-plan.md"]);
    });
    it("catches a gitignored .env created by a traditional section with a timestamp", () => {
      expect(check(`${clean}--- /dev/null\t2026-01-01\n+++ b/.env.local\t2026-01-01\n@@ -0,0 +1 @@\n+K=1\n`).status).toBe(1);
    });
    it("catches a patch that touches only the loop's state files (no exemption for an implementer patch)", () => {
      const out = check("diff --git a/.claude/memory/loop-plan.md b/.claude/memory/loop-plan.md\n--- a/.claude/memory/loop-plan.md\n+++ b/.claude/memory/loop-plan.md\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/.claude/memory/trace/records.jsonl b/.claude/memory/trace/records.jsonl\n--- a/.claude/memory/trace/records.jsonl\n+++ b/.claude/memory/trace/records.jsonl\n@@ -1 +1,2 @@\n a\n+b\n");
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).hits.sort()).toEqual([".claude/memory/loop-plan.md", ".claude/memory/trace/records.jsonl"]);
    });
    it("catches a rename that moves a protected file away (both sides are checked)", () => {
      expect(check("diff --git a/.claude/loop.md b/docs/x.md\nsimilarity index 100%\nrename from .claude/loop.md\nrename to docs/x.md\n").status).toBe(1);
    });
    it("fails closed (exit 2) when git cannot parse the patch, the file is missing, or no --patch is given", () => {
      expect(check("not a patch\n").status).toBe(2);
      expect(trace(["denylist-check", "--patch", join(dir, "missing.patch")]).status).toBe(2);
      expect(trace(["denylist-check"]).status).toBe(2);
    });
  });

  describe("bench-score --record fails closed", () => {
    const RUN = "0a1b2c3d";
    const setup = (transcripts, { runId = RUN, agents, repeats = 1, only = () => true } = {}) => {
      const m = readBench();
      const runs = join(dir, "runs.json");
      const verifierRuns = m.fixtures.filter(only).flatMap((f) => Array.from({ length: repeats }, (_, repeat) => ({ arm: "verifier", repeat, fixtureId: opaqueFixtureId(f.id), verdict: "defer", failedGates: [], missing: ["x"] })));
      writeFileSync(runs, JSON.stringify({ ...(runId ? { runId } : {}), ...(agents != null ? { agents } : {}), runs: verifierRuns }));
      const tdir = join(dir, "transcripts");
      mkdirSync(tdir);
      transcripts(m).forEach((t, i) => {
        writeFileSync(join(tdir, `agent-${i}.jsonl`), t.text);
        writeFileSync(join(tdir, `agent-${i}.meta.json`), JSON.stringify({ description: t.label }));
      });
      return (extra = []) => trace(["bench-score", runs, "--transcripts", tdir, "--record", ...extra]);
    };
    // Boolean checks only: bench-score's stdout names fixtures, and a failing toMatch would print it.
    const says = (out, re) => re.test(out.stdout);
    const covering = (m, run = RUN, repeats = 1) =>
      m.fixtures.flatMap((f, i) => Array.from({ length: repeats }, (_, r) => ({ label: `bench-verify:${opaqueFixtureId(f.id)}-r${r}-${i}@${run}`, text: "clean" })));
    it("on an empty transcript dir", () => {
      const out = setup(() => [])();
      expect(out.status).toBe(1);
      expect(says(out, /holds no agent transcripts/)).toBe(true);
    });
    it("on a leak in a transcript that cannot be tied to a run", () => {
      expect(setup((m) => [...covering(m), { label: "some-other-agent", text: `saw ${m.fixtures[0].id}` }])().status).toBe(1);
    });
    it("when the transcripts do not cover the runs", () => {
      const out = setup(() => [{ label: "critic:security-1", text: "clean" }])();
      expect(out.status).toBe(1);
      expect(says(out, /no scanned transcript/)).toBe(true);
    });
    it("when the transcripts belong to ANOTHER bench run (same fixtures, different run id)", () => {
      const out = setup((m) => covering(m, "ffffffff"))();
      expect(out.status).toBe(1);
      expect(says(out, /no scanned transcript/)).toBe(true);
    });
    it("when a transcript is empty (nothing was scanned)", () => {
      expect(setup((m) => covering(m).map((t, i) => (i === 0 ? { ...t, text: "" } : t)))().status).toBe(1);
    });
    it("for runs without a run id (args not minted by bench-args)", () => {
      const out = setup((m) => covering(m, "").map((t) => ({ ...t, label: t.label.replace(/@$/, "") })), { runId: "" })();
      expect(out.status).toBe(1);
      expect(says(out, /run id/)).toBe(true);
    });
    it("on a leak in a transcript of ANOTHER run in the same dir (never silently ignored)", () => {
      const out = setup((m) => [...covering(m), { label: `bench-verify:${opaqueFixtureId(m.fixtures[0].id)}-r0-0@ffff9999`, text: `saw ${m.fixtures[0].id}` }])();
      expect(out.status).toBe(1);
      expect(says(out, /cannot be tied to a run/)).toBe(true);
    });
    it("records an accept when every run is covered and nothing leaked — and refuses the same run id twice", () => {
      const record = setup(covering);
      expect(record().status).toBe(0);
      expect(JSON.parse(readFileSync(store, "utf8").trim().split("\n")[0])).toMatchObject({ claim_id: "bench:trace-bench-lite", final_status: "accept" });
      const again = record();
      expect(again.status).toBe(1);
      expect(says(again, /already recorded/)).toBe(true);
    });
    it("excludes a run whose OWN transcript leaked, and records a qualify (not a clean accept)", () => {
      expect(setup((m) => covering(m).map((t, i) => (i === 0 ? { ...t, text: `saw ${m.fixtures[0].id}` } : t)))().status).toBe(0);
      expect(JSON.parse(readFileSync(store, "utf8").trim().split("\n")[0])).toMatchObject({ final_status: "qualify" });
    });
    it("records a qualify, not an accept, when the workflow started more agents than it returned runs (a vanished run)", () => {
      expect(setup(covering, { agents: readBench().fixtures.length + 1 })().status).toBe(0);
      const rec = JSON.parse(readFileSync(store, "utf8").trim().split("\n")[0]);
      expect(rec).toMatchObject({ claim_id: "bench:trace-bench-lite", final_status: "qualify" });
      expect(rec.failed_gates).toContain("F0 validity");
    });
    // L3 freshness: the recorded run names the verifier it measured, and l3-check reads that record.
    const namesCurrentVerifier = () =>
      JSON.parse(readFileSync(store, "utf8").trim().split("\n").at(-1)).evidence.some((e) => e.kind === "file_line" && e.ref === ".claude/workflows/loop-iteration.js" && e.result === `<loop-verifier> sha256=${CURRENT_VERIFIER}`);
    it("records the sha256 of loop-iteration.js's <loop-verifier> block; at one repeat l3-check still exits 1 on the repeat count", () => {
      expect(setup(covering)().status).toBe(0);
      expect(namesCurrentVerifier()).toBe(true);
      const out = trace(["l3-check", "--json"]);
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).unmet).toEqual([expect.stringMatching(/ran 1 repeat\(s\)/)]);
    });
    it("a clean run at repeat 2 is recorded with the current verifier's hash, and l3-check exits 0 on it", () => {
      expect(setup((m) => covering(m, RUN, 2), { repeats: 2 })().status).toBe(0);
      expect(namesCurrentVerifier()).toBe(true);
      const out = trace(["l3-check", "--json"]);
      expect(out.status).toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, unmet: [], verdict: "accept", repeats: 2, recordHash: CURRENT_VERIFIER, currentHash: CURRENT_VERIFIER });
    });
    it("a clean run over part of the manifest (the good fixtures only, repeat 2) is recorded with the counts it measured, and l3-check exits 1 on the full-manifest condition alone", () => {
      const good = (f) => f.kind === "good";
      expect(setup((m) => covering({ fixtures: m.fixtures.filter(good) }, RUN, 2), { repeats: 2, only: good })().status).toBe(0);
      const rec = JSON.parse(readFileSync(store, "utf8").trim().split("\n").at(-1));
      expect(rec.final_status).toBe("accept");
      const metrics = JSON.parse(rec.evidence.find((e) => e.kind === "measurement").result);
      const all = readBench().fixtures;
      const counts = { bad: all.filter((f) => !good(f)).length, good: all.filter(good).length };
      expect(metrics.fixtures).toEqual(counts);
      expect(metrics.arms.verifier.measured).toEqual({ bad: 0, good: counts.good });
      expect(namesCurrentVerifier()).toBe(true);
      const out = trace(["l3-check", "--json"]);
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).unmet).toEqual([expect.stringMatching(new RegExp(`measured 0/${counts.bad} bad and ${counts.good}/${counts.good} good manifest fixtures`))]);
    });
    it("refuses to record when the results path itself carries ground truth (the evidence ref is screened)", () => {
      const m = readBench();
      const named = join(dir, `${m.fixtures[0].id}.json`);
      setup(covering);
      writeFileSync(named, readFileSync(join(dir, "runs.json")));
      const out = trace(["bench-score", named, "--transcripts", join(dir, "transcripts"), "--record"]);
      expect(out.status).toBe(1);
      expect(says(out, /bench ground truth/)).toBe(true);
    });
  });
});

// L3 freshness, as a process: loop-checklist.md's measured-checker item computed from the latest
// bench record (a temp store) and the working tree's <loop-verifier> block.
describe("l3-check (CLI process)", () => {
  it("exits 0 on a temp store whose latest bench record is an accept from repeat ≥ 2 that measured the current block; text and --json agree", () => {
    expect(trace(["write", "-"], benchDraft()).status).toBe(0);
    const json = trace(["l3-check", "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, unmet: [], record_id: expect.stringMatching(/^TR-[0-9a-f]{12}$/), verdict: "accept", repeats: 2, recordHash: CURRENT_VERIFIER, currentHash: CURRENT_VERIFIER });
    const text = trace(["l3-check"]);
    expect(text.status).toBe(0);
    expect(text.stdout.startsWith("l3-check: met")).toBe(true);
  });

  it.each([
    ["a hash mismatch (the verifier changed after the bench)", { hash: "0".repeat(64) }, /another <loop-verifier> block/],
    ["a qualify", { status: "qualify" }, /qualify, not accept/],
    ["a single repeat", { repeats: 1 }, /ran 1 repeat\(s\)/],
    ["an F3", { gates: ["F2 (informational)", "F3 instability"] }, /F3 instability/],
    ["a verifier bench of part of the manifest", { measured: { bad: 1, good: 2 } }, /measured 1\/2 bad and 2\/2 good manifest fixtures/],
  ])("exits 1 on %s, listing exactly that unmet condition", (_what, over, re) => {
    expect(trace(["write", "-"], benchDraft(over)).status).toBe(0);
    const json = trace(["l3-check", "--json"]);
    expect(json.status).toBe(1);
    const res = JSON.parse(json.stdout);
    expect(res.ok).toBe(false);
    expect(res.unmet).toHaveLength(1);
    expect(res.unmet[0]).toMatch(re);
    const text = trace(["l3-check"]);
    expect(text.status).toBe(1);
    expect(text.stdout.startsWith("l3-check: NOT met")).toBe(true);
    expect(text.stdout).toMatch(re);
  });

  it("at HEAD: while the committed store's latest bench record names no verifier, l3-check exits 1 for the missing hash", () => {
    // The committed store is append-only state a re-bench extends: compare, never pin it.
    const state = replay(loadEntries(DEFAULT_STORE), loadSchema(), readPolicyVersion());
    const latest = latestByClaim(state.records, state.superseded).get("bench:trace-bench-lite");
    const named = !!latest && latest.evidence.some((e) => e.kind === "file_line" && /^<loop-verifier> sha256=/.test(e.result || ""));
    const out = trace(["l3-check", "--json", "--store", DEFAULT_STORE]);
    const res = JSON.parse(out.stdout);
    expect(out.status).toBe(res.ok ? 0 : 1);
    expect(res.record_id).toBe(latest ? latest.record_id : null);
    if (!named) {
      expect(out.status).toBe(1);
      expect(res.unmet.some((u) => u.includes("no <loop-verifier> hash"))).toBe(true);
    }
  });

  it("fails closed (exit 1) with no bench record, and when the store does not replay", () => {
    const empty = trace(["l3-check", "--json"]);
    expect(empty.status).toBe(1);
    expect(JSON.parse(empty.stdout).unmet).toEqual([expect.stringMatching(/no bench:trace-bench-lite record/)]);
    writeFileSync(store, "{not json\n");
    const broken = trace(["l3-check", "--json"]);
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).unmet.some((u) => /does not replay/.test(u))).toBe(true);
  });
});

// End-to-end CLI wiring that touches HEAD, the working tree or the fixture bundle runs in a
// throwaway repo holding a COPY of the trace tooling — never in the real tree.
function tempRepo({ manifest, repo = "commit" } = {}) {
  const d = mkdtempSync(join(tmpdir(), "trace-repo-"));
  const copy = (rel) => {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), readFileSync(join(ROOT, rel)));
  };
  for (const f of ["lib.mjs", "cli.mjs", "bench-judge.mjs", "plan.mjs", "story-map.mjs"]) copy(`scripts/trace/${f}`);
  for (const f of [".claude/workflows/loop-iteration.js", ".claude/trace/schema-v1.json", ".claude/memory/topics/trace.md"]) copy(f);
  const bundle = join(d, ".claude/trace/bench/fixtures.bundle");
  const setBundle = (m) => {
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, encodeBench(m));
  };
  if (manifest) setBundle(manifest);
  const git = (...a) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: d, encoding: "utf8" });
  // repo: "commit" (default), "init" (an unborn HEAD) or "none" (not a git repo at all).
  if (repo !== "none") git("init", "-q");
  if (repo === "commit") {
    git("add", "-A");
    git("commit", "-qm", "init");
  }
  const cli = (args, input) =>
    spawnSync(process.execPath, [join(d, "scripts/trace/cli.mjs"), ...args], { cwd: d, encoding: "utf8", input, env: { ...process.env, TRACE_STORE: join(d, "store.jsonl") } });
  return { d, git, cli, setBundle, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe("CLI wiring, end to end in a throwaway repo", () => {
  it("denylist-check reads the denylist from HEAD — a weakened working-tree copy cannot pass a protected path", () => {
    const r = tempRepo();
    try {
      const wf = join(r.d, ".claude/workflows/loop-iteration.js");
      const src = readFileSync(wf, "utf8");
      const weakened = src.replace("const hitsDenylist = (files) =>", "const hitsDenylist = () => false; const unusedDenylist = (files) =>");
      expect(weakened).not.toBe(src);
      writeFileSync(wf, weakened); // uncommitted: HEAD still has the real denylist
      const p = join(r.d, "x.patch");
      writeFileSync(p, "diff --git a/.claude/loop.md b/.claude/loop.md\n--- a/.claude/loop.md\n+++ b/.claude/loop.md\n@@ -1 +1 @@\n-a\n+b\n");
      expect(r.cli(["denylist-check", "--patch", p]).status).toBe(1);
    } finally {
      r.cleanup();
    }
  });

  const srcPatch = "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+x\n";
  it("denylist-check fails closed (exit 2) without a HEAD to read the denylist from, or outside a git repo", () => {
    for (const repo of ["init", "none"]) {
      const r = tempRepo({ repo });
      try {
        const p = join(r.d, "x.patch");
        writeFileSync(p, srcPatch);
        expect(r.cli(["denylist-check", "--patch", p]).status).toBe(2);
      } finally {
        r.cleanup();
      }
    }
  });

  it("denylist-check judges the patch, not the tree: an unrelated uncommitted .claude/ edit does not block an innocent patch", () => {
    const r = tempRepo();
    try {
      writeFileSync(join(r.d, ".claude/notes.md"), "uncommitted wiki edit\n"); // what /dream leaves behind
      writeFileSync(join(r.d, "CLAUDE.md"), "uncommitted\n");
      const p = join(r.d, "x.patch");
      writeFileSync(p, srcPatch);
      expect(r.cli(["denylist-check", "--patch", p]).status).toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it("bench-args stops on a left-applied fixture, and `bench-judge --recover` reverses it and stops (never runs the judges)", () => {
    const file = "a-seeded.txt";
    const patch = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+seeded\n`;
    const good = `diff --git a/b-good.txt b/b-good.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b-good.txt\n@@ -0,0 +1 @@\n+fine\n`;
    const manifest = {
      fixtures: [
        { id: "B90-synthetic", kind: "bad", item: "x", defect: "seeded synthetic defect", claimType: "factual", patch, judge: { kind: "command", command: "false", catches: true } },
        { id: "G90-synthetic", kind: "good", item: "y", claimType: "factual", patch: good, judge: { kind: "none", catches: false } },
      ],
    };
    const r = tempRepo({ manifest });
    try {
      expect(spawnSync("git", ["apply", "-"], { cwd: r.d, input: patch }).status).toBe(0); // a killed run left it applied
      expect(existsSync(join(r.d, file))).toBe(true);
      expect(r.cli(["bench-args"]).status).toBe(1);
      const rec = r.cli(["bench-judge", "--recover"]);
      expect(rec.status).toBe(0); // with a judge of `false`, running on would fail the baseline
      expect(JSON.parse(rec.stdout).reversed).toEqual([opaqueFixtureId("B90-synthetic")]);
      expect(existsSync(join(r.d, file))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("l3-check hashes the working tree's <loop-verifier> block: an edit inside it fails a matching record, an edit outside it does not, a missing file fails closed", () => {
    const r = tempRepo();
    try {
      expect(r.cli(["write", "-"], benchDraft()).status).toBe(0); // the copy's block hashes like the real one
      expect(r.cli(["l3-check"]).status).toBe(0);
      const wf = join(r.d, ".claude/workflows/loop-iteration.js");
      const src = readFileSync(wf, "utf8");
      const outside = src.replace("// </loop-verifier>\n", "// </loop-verifier>\n// a comment below the block\n");
      const inside = src.replace("You are a SEPARATE verifier", "You are a SEPARATE, edited verifier");
      expect(outside).not.toBe(src);
      expect(inside).not.toBe(src);
      writeFileSync(wf, outside);
      expect(r.cli(["l3-check"]).status).toBe(0);
      writeFileSync(wf, inside); // uncommitted: the current verifier is the working tree's, not HEAD's
      const edited = r.cli(["l3-check", "--json"]);
      expect(edited.status).toBe(1);
      expect(JSON.parse(edited.stdout).unmet).toEqual([expect.stringMatching(/another <loop-verifier> block/)]);
      rmSync(wf);
      const gone = r.cli(["l3-check", "--json"]);
      expect(gone.status).toBe(1);
      expect(JSON.parse(gone.stdout).unmet).toEqual([expect.stringMatching(/cannot be read/)]);
    } finally {
      r.cleanup();
    }
  });

  it("reaudit --act screens its notes and exits 1 when the batch is refused", () => {
    const r = tempRepo();
    try {
      const cited = "src/B90-synthetic-x.ts";
      mkdirSync(join(r.d, "src"), { recursive: true });
      writeFileSync(join(r.d, cited), "export const a = 1;\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "cited file");
      const draft = { writer_id: "test", claim_id: "cli:cited", claim_text: "a claim", claim_type: "factual", evidence: [{ kind: "file_line", ref: `${cited}:1` }], final_status: "accept", reason: "r", provenance: { workflow: "test" } };
      expect(r.cli(["write", "-"], JSON.stringify(draft)).status).toBe(0);
      // Later the fixture bundle names that path's token as ground truth, and the cited file changes.
      r.setBundle({ fixtures: [{ id: "B90-synthetic-x", kind: "bad", item: "x", defect: "d", claimType: "factual", patch: "diff --git a/q b/q\n", judge: { kind: "none", catches: false } }] });
      writeFileSync(join(r.d, cited), "export const a = 2;\n");
      expect(r.cli(["reaudit", "--act"]).status).toBe(1);
      expect(readFileSync(join(r.d, "store.jsonl"), "utf8").trim().split("\n")).toHaveLength(1); // nothing appended
    } finally {
      r.cleanup();
    }
  });

  it("reaudit lists a record whose commit was squashed away as `unreachable`, apart from changed evidence, and --act notes it so", () => {
    const r = tempRepo();
    try {
      mkdirSync(join(r.d, "src"), { recursive: true });
      for (const f of ["a.ts", "b.ts"]) writeFileSync(join(r.d, "src", f), "export const a = 1;\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "cited files");
      const fact = (claim, ref) => JSON.stringify({ writer_id: "test", claim_id: claim, claim_text: claim, claim_type: "factual", evidence: [{ kind: "file_line", ref }], final_status: "accept", reason: "r", provenance: { workflow: "test" } });
      expect(r.cli(["write", "-"], fact("cli:squashed", "src/a.ts:1")).status).toBe(0); // stamped with this commit
      // Squash it away: rewrite the commit, then expire the reflog and prune, as gc after a squash-merge
      // (or a fresh clone) leaves it. The tree is unchanged, so src/a.ts did not change either.
      for (const step of [["commit", "-q", "--amend", "-m", "squashed"], ["reflog", "expire", "--expire=now", "--all"], ["gc", "-q", "--prune=now"]]) expect(r.git(...step).status).toBe(0);
      expect(r.cli(["write", "-"], fact("cli:changed", "src/b.ts:1")).status).toBe(0); // stamped with the new HEAD
      writeFileSync(join(r.d, "src", "b.ts"), "export const a = 2;\n");
      const out = r.cli(["reaudit"]);
      expect(out.status).toBe(0);
      const byClaim = Object.fromEntries(JSON.parse(out.stdout).map((c) => [c.claim_id, c]));
      expect(Object.keys(byClaim).sort()).toEqual(["cli:changed", "cli:squashed"]);
      expect(byClaim["cli:squashed"]).toMatchObject({ unreachable: expect.stringMatching(/^[0-9a-f]{12}$/), paths: ["src/a.ts"] });
      expect(byClaim["cli:squashed"].changed).toBeUndefined();
      expect(byClaim["cli:changed"]).toMatchObject({ changed: ["src/b.ts"] });
      expect(byClaim["cli:changed"].unreachable).toBeUndefined();
      expect(r.cli(["reaudit", "--act"]).status).toBe(0);
      const notes = readFileSync(join(r.d, "store.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "action").map((a) => a.note);
      expect(notes.sort()).toEqual(["evidence changed: src/b.ts", `provenance commit ${byClaim["cli:squashed"].unreachable} is unreachable — re-verify: src/a.ts`]);
    } finally {
      r.cleanup();
    }
  });

  it("wiki-check: the template's rec comments over an empty store name no record (exit 1) until stripped (exit 0, and a size warning alone still exits 0); a store that does not replay exits 2", () => {
    const r = tempRepo(); // its memory holds only the policy page: no index.md or quarantine.md (tolerated)
    try {
      const policy = join(r.d, ".claude/memory/topics/trace.md");
      const cited = [...readFileSync(policy, "utf8").matchAll(/<!--\s*rec:(TR-[0-9a-f]{12})\s*-->/g)].map((m) => m[1]);
      expect(cited.length).toBeGreaterThan(0);
      const out = r.cli(["wiki-check"]);
      expect(out.status).toBe(1);
      const res = JSON.parse(out.stdout);
      expect(res.ok).toBe(false);
      expect(res.errors).toHaveLength(cited.length);
      expect(res.errors.every((e) => /names no record/.test(e) && /strip the comment/.test(e))).toBe(true);
      // The adoption guide's fix for a store started empty: strip the comments, keep the facts as legacy bullets.
      writeFileSync(policy, readFileSync(policy, "utf8").replace(/\s*<!--\s*rec:TR-[0-9a-f]{12}\s*-->/g, ""));
      const clean = r.cli(["wiki-check"]);
      expect(clean.status).toBe(0);
      expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, errors: [], pages: 1 });
      // A warning alone never fails the run: a topic page over 200 lines is a split proposal, not an error.
      writeFileSync(join(r.d, ".claude/memory/topics/big.md"), Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
      const warned = r.cli(["wiki-check"]);
      expect(warned.status).toBe(0);
      const sized = JSON.parse(warned.stdout);
      expect(sized).toMatchObject({ ok: true, errors: [], pages: 2 });
      expect(sized.warnings).toHaveLength(1);
      expect(sized.warnings[0].startsWith("topics/big.md: 201 lines (> 200)")).toBe(true);
      writeFileSync(join(r.d, "store.jsonl"), "{not json\n");
      const broken = r.cli(["wiki-check"]);
      expect(broken.status).toBe(2);
      expect(JSON.parse(broken.stdout).ok).toBe(false);
    } finally {
      r.cleanup();
    }
  });
});
