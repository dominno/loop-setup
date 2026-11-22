// The sanctioned writer is the CLI, so test it as a process: exit codes, fail-closed
// paths, and the bench-judge safety helpers.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_STORE, encodeBench, latestByClaim, loadEntries, loadSchema, opaqueFixtureId, readBench, readPolicyVersion, replay, ROOT, WORKSPACE } from "./lib.mjs";
import { appliedFixtures, benchPreconditionStep, benchPreflight, judgeEnv, runBenchJudge, runJudge, SIGNALS } from "./bench-judge.mjs";
import { DEFAULT_PLAN, parsePlan, readyIds } from "./plan.mjs";
import { STORY_MAP_PATHS } from "./story-map.mjs";
import { MODE_PATCHES } from "../test/denylist-modes.mjs";
import { resolveLegacyRef } from "../setup/layout.mjs";

const CLI = join(ROOT, "kit/trace/cli.mjs");
let dir;
let store;
// A Claude config dir whose user settings switch the sandbox on and hold the unsandboxed fallback
// closed (what l3-check requires besides the bench): the CLI never reads the developer's own settings.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "trace-claude-"));
writeFileSync(join(SANDBOX_HOME, "settings.json"), JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }));
afterAll(() => rmSync(SANDBOX_HOME, { recursive: true, force: true }));
const trace = (args, input, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", input, env: { ...process.env, TRACE_STORE: store, CLAUDE_CONFIG_DIR: SANDBOX_HOME, ...env } });
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
const CURRENT_VERIFIER = verifierSha(readFileSync(join(ROOT, "kit/workflows/loop-iteration.js"), "utf8"));
// The same for the <loop-denylist> block, which a bench record pins beside the verifier.
const denylistSha = (text) => createHash("sha256").update(/\/\/ <loop-denylist>\n[\s\S]*?\/\/ <\/loop-denylist>\n/.exec(text)[0]).digest("hex");
const CURRENT_DENYLIST = denylistSha(readFileSync(join(ROOT, "kit/workflows/loop-iteration.js"), "utf8"));
const benchDraft = ({ status = "accept", repeats = 2, gates = ["F2 (informational)"], hash = CURRENT_VERIFIER, denylist = CURRENT_DENYLIST, measured = { bad: 2, good: 2 } } = {}) =>
  JSON.stringify({
    writer_id: "trace-bench/score",
    claim_id: "bench:trace-bench-lite",
    claim_text: `TRACE-Bench-lite (2 bad / 2 good fixtures): ${status} at ${repeats} repeat(s)`,
    claim_type: "measured",
    evidence: [
      { kind: "measurement", ref: "loop-setup bench-score runs.json [runs 0a1b2c3d]", result: JSON.stringify({ fixtures: { bad: 2, good: 2 }, arms: { verifier: { repeats, measured } } }) },
      { kind: "file_line", ref: "kit/workflows/loop-iteration.js", result: `<loop-verifier> sha256=${hash}` },
      ...(denylist ? [{ kind: "file_line", ref: "kit/workflows/loop-iteration.js", result: `<loop-denylist> sha256=${denylist}` }] : []),
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

describe("loop-setup (CLI process)", () => {
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
  const PAGE_REFS = ["topics/x.md", "./topics/x.md", ".claude/loop-workspace/topics/x.md"];

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
  const OPEN_BLOCKER_CHECK = "loop-setup query --latest --writer critic-panel --severity blocker --json";
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
    const documented = OPEN_BLOCKER_CHECK.split(" ").slice(2, -1); // the flags between `query` and `--json`
    expect(ids(...documented)).toEqual([deferred]);
    for (const doc of ["kit/commands/critic-round.md", "kit/commands/multi-agent-dev.md"]) {
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

  it("plan-ready ranks the ready ids by their origin record's severity from the replayed store, and exits 2 when the store does not replay", () => {
    expect(trace(["write", "-"], draft({ writer_id: "critic-panel/verify:a-0", claim_id: "critic:a:blocker", severity: "blocker" })).status).toBe(0);
    const [blocker] = JSON.parse(trace(["query", "--json"]).stdout).map((r) => r.record_id);
    const p = writePlan("| LP-001 | first | — | ready | | | human | |", `| LP-002 | second | — | ready | | | critic:a rec:${blocker} | |`);
    expect(JSON.parse(trace(["plan-ready", "--plan", p]).stdout)).toEqual(["LP-002", "LP-001"]);
    writeFileSync(store, `${readFileSync(store, "utf8")}not json\n`);
    const broken = trace(["plan-ready", "--plan", p]);
    expect(broken.status).toBe(2);
    expect(broken.stdout).toBe("");
  });

  it("plan-lint --pre-dispatch --max-scope 1 (the L3 ceiling) fails a ready node with two scope paths; a value above 3 is a usage error", () => {
    const H10 = "| id | description | after | status | record | missing | origin | notes | scope | check |\n|---|---|---|---|---|---|---|---|---|---|";
    const p = join(dir, "loop-plan-scope.md");
    writeFileSync(p, `## Plan\n\n${H10}\n| LP-001 | w | — | ready | | | human | | src/a.ts, src/a.test.ts | pnpm test |\n`);
    expect(trace(["plan-lint", "--pre-dispatch", "--plan", p]).status).toBe(0);
    const l3 = trace(["plan-lint", "--pre-dispatch", "--max-scope", "1", "--plan", p]);
    expect(l3.status).toBe(1);
    expect(l3.stderr).toMatch(/\[oversize\] LP-001/);
    expect(trace(["plan-lint", "--pre-dispatch", "--max-scope", "4", "--plan", p]).status).toBe(2);
  });

  it("plan-ready --batch N prints a conflict-free batch by scope and names each skipped id on stderr; --batch with --max is a usage error", () => {
    const H10 = "| id | description | after | status | record | missing | origin | notes | scope | check |\n|---|---|---|---|---|---|---|---|---|---|";
    const p = join(dir, "loop-plan-batch.md");
    writeFileSync(p, `## Plan\n\n${H10}\n| LP-001 | a | — | ready | | | human | | src/a.ts | pnpm test |\n| LP-002 | b | — | ready | | | human | | src/a.ts | pnpm test |\n| LP-003 | c | — | ready | | | human | | src/c.ts | pnpm test |\n`);
    const out = trace(["plan-ready", "--batch", "5", "--plan", p]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(["LP-001", "LP-003"]);
    expect(out.stderr).toMatch(/skip: LP-002 conflicts with LP-001/);
    expect(trace(["plan-ready", "--batch", "5", "--max", "2", "--plan", p]).status).toBe(2);
    expect(trace(["plan-ready", "--batch", "0", "--plan", p]).status).toBe(2);
  });

  it("plan-lint reads the story ids from docs/stories and warns [story-dangling]; story-lint --plan lists open nodes per story", () => {
    const p = writePlan("| LP-001 | a | — | ready | | | story:US-001#AC1 | |", "| LP-002 | b | — | ready | | | story:US-999#AC1 | |");
    const out = trace(["plan-lint", "--plan", p]);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(/warn: \[story-dangling\] LP-002/);
    expect(out.stderr).not.toMatch(/\[story-dangling\] LP-001/);
    const stories = trace(["story-lint", "--plan", p]);
    expect(stories.stderr).toMatch(/warn: \[plan-nodes\] US-001 .*LP-001/);
  });

  it("plan-drift is advisory: exit 0 with the drift JSON against --base-plan, labelled consistency, not truth", () => {
    const now = writePlan("| LP-001 | a | — | ready | | | human | |", "| LP-002 | b | — | ready | | | human | |");
    const base = writePlan("| LP-001 | a | — | blocked | | | human | |");
    const out = trace(["plan-drift", "--plan", now, "--base-plan", base]);
    expect(out.status).toBe(0);
    const j = JSON.parse(out.stdout);
    expect(j).toMatchObject({ added: ["LP-002"], removed: [], changed: [{ id: "LP-001", from: "blocked", to: "ready" }] });
    expect(j.note).toMatch(/consistency, not truth/);
  });

  it("status prints the read-only rollup (exit 0), and exits 2 when the store does not replay", () => {
    const p = writePlan("| LP-001 | a | — | ready | | | human | |", "| LP-002 | b | LP-001 | blocked | | | human | |");
    const out = trace(["status", "--plan", p]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ byStatus: { ready: 1, blocked: 1 }, note: expect.stringMatching(/consistency, not truth/) });
    writeFileSync(store, "not json\n", { flag: "a" });
    expect(trace(["status", "--plan", p]).status).toBe(2);
  });

  it("plan-id prints a fresh LP-<6 hex> id not in the plan or the store (owner from LOOP_OWNER)", () => {
    const p = writePlan("| LP-001 | a | — | ready | | | human | |");
    const out = spawnSync(process.execPath, [CLI, "plan-id", "Fix the empty-name crash", "--plan", p], { encoding: "utf8", env: { ...process.env, TRACE_STORE: store, LOOP_OWNER: "ana" } });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/^LP-[0-9a-f]{6}$/);
    expect(trace(["plan-id"]).status).toBe(2); // a description is required
  });

  it("claim-token prints claim:<owner>@<YYYYMMDD-HHMM>; plan-lint reads --run-log to tell a live claim from a stale one", () => {
    const env = { ...process.env, TRACE_STORE: store, LOOP_OWNER: "ana" };
    const tok = spawnSync(process.execPath, [CLI, "claim-token"], { encoding: "utf8", env });
    expect(tok.status).toBe(0);
    expect(tok.stdout.trim()).toMatch(/^claim:ana@\d{8}-\d{4}$/);
    const log = join(dir, "run-log.md");
    writeFileSync(log, "## [2026-11-06 11:00] L2 | ben\n- owner: ben\n- actions: x\n");
    const p = writePlan("| LP-001 | a | — | in-progress | | | human | claim:ben@20261106-1100 |");
    const out = spawnSync(process.execPath, [CLI, "plan-lint", "--pre-dispatch", "--plan", p, "--run-log", log], { encoding: "utf8", env });
    expect(out.status).toBe(0); // ben's live claim only warns: it is not ana's to reset
    expect(out.stderr).toMatch(/\[in-progress-claimed\] LP-001/);
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

  // LP-003 waits on two nodes: LP-001 is done, LP-002 is `second`.
  const twoDeps = (second) =>
    writePlan("| LP-001 | first | — | done | | | human | |", `| LP-002 | second | — | ${second} | | | human | |`, "| LP-003 | third | LP-001, LP-002 | blocked | | | human | |");

  it("plan-ready omits a node with several after ids while one of them is open (one done is not enough), and prints it once every one is done", () => {
    const half = trace(["plan-ready", "--plan", twoDeps("ready")]);
    expect(half.status).toBe(0);
    expect(JSON.parse(half.stdout)).toEqual(["LP-002"]);
    const both = trace(["plan-ready", "--plan", twoDeps("done")]);
    expect(both.status).toBe(0);
    expect(JSON.parse(both.stdout)).toEqual(["LP-003"]);
  });

  it("plan-items refuses a node with several after ids while one of them is open, naming only the open one (waits on LP-002), and emits it once every one is done", () => {
    const refused = trace(["plan-items", "LP-003", "--plan", twoDeps("ready")]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe(""); // no items
    expect(refused.stderr).toMatch(/^error: LP-003: not ready: waits on LP-002$/m);
    const items = trace(["plan-items", "LP-003", "--plan", twoDeps("done")]);
    expect(items.status).toBe(0);
    expect(JSON.parse(items.stdout)).toEqual([{ id: "LP-003", description: "third" }]);
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
  const tmpName = `kit/trace/.bench-judge-test-${process.pid}.txt`;
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
    const gone = `kit/trace/.bench-judge-missing-${process.pid}.txt`;
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
    const gone = `kit/trace/.bench-judge-missing-${process.pid}.txt`;
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
  const other = `kit/trace/.bench-judge-test-${process.pid}-b.txt`;
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
    const out = trace(["bench-unpack", `kit/trace/.no-such-dir-${process.pid}`]);
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
      const out = check(`${clean}--- c/.claude/loop-workspace/loop-plan.md\n+++ c/.claude/loop-workspace/loop-plan.md\n@@ -1 +1 @@\n-a\n+b\n`);
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).hits).toEqual([".claude/loop-workspace/loop-plan.md"]);
    });
    it("catches a gitignored .env created by a traditional section with a timestamp", () => {
      expect(check(`${clean}--- /dev/null\t2026-01-01\n+++ b/.env.local\t2026-01-01\n@@ -0,0 +1 @@\n+K=1\n`).status).toBe(1);
    });
    it("catches a patch that touches only the loop's state files (no exemption for an implementer patch)", () => {
      const out = check("diff --git a/.claude/loop-workspace/loop-plan.md b/.claude/loop-workspace/loop-plan.md\n--- a/.claude/loop-workspace/loop-plan.md\n+++ b/.claude/loop-workspace/loop-plan.md\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/.claude/loop-workspace/trace/records.jsonl b/.claude/loop-workspace/trace/records.jsonl\n--- a/.claude/loop-workspace/trace/records.jsonl\n+++ b/.claude/loop-workspace/trace/records.jsonl\n@@ -1 +1,2 @@\n a\n+b\n");
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).hits.sort()).toEqual([".claude/loop-workspace/loop-plan.md", ".claude/loop-workspace/trace/records.jsonl"]);
    });
    it("catches a rename that moves a protected file away (both sides are checked)", () => {
      expect(check("diff --git a/kit/loop.md b/docs/x.md\nsimilarity index 100%\nrename from kit/loop.md\nrename to docs/x.md\n").status).toBe(1);
    });
    it("fails closed (exit 2) when git cannot parse the patch, the file is missing, or no --patch is given", () => {
      expect(check("not a patch\n").status).toBe(2);
      expect(trace(["denylist-check", "--patch", join(dir, "missing.patch")]).status).toBe(2);
      expect(trace(["denylist-check"]).status).toBe(2);
    });
  });

  describe("bench-score --record fails closed", () => {
    const RUN = "0a1b2c3d";
    const writeTranscripts = (list) => {
      const tdir = join(dir, "transcripts");
      mkdirSync(tdir);
      list.forEach((t, i) => {
        writeFileSync(join(tdir, `agent-${i}.jsonl`), t.text);
        writeFileSync(join(tdir, `agent-${i}.meta.json`), JSON.stringify({ description: t.label }));
      });
      return tdir;
    };
    const setup = (transcripts, { runId = RUN, agents, repeats = 1, only = () => true } = {}) => {
      const m = readBench();
      const runs = join(dir, "runs.json");
      const verifierRuns = m.fixtures.filter(only).flatMap((f) => Array.from({ length: repeats }, (_, repeat) => ({ arm: "verifier", repeat, fixtureId: opaqueFixtureId(f.id), verdict: "defer", failedGates: [], missing: ["x"] })));
      writeFileSync(runs, JSON.stringify({ ...(runId ? { runId } : {}), ...(agents != null ? { agents } : {}), runs: verifierRuns }));
      const tdir = writeTranscripts(transcripts(m));
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
      JSON.parse(readFileSync(store, "utf8").trim().split("\n").at(-1)).evidence.some((e) => e.kind === "file_line" && e.ref === "kit/workflows/loop-iteration.js" && e.result === `<loop-verifier> sha256=${CURRENT_VERIFIER}`);
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
    it("the recorded run also names the working tree's <loop-denylist> block, which l3-check compares", () => {
      expect(setup((m) => covering(m, RUN, 2), { repeats: 2 })().status).toBe(0);
      const rec = JSON.parse(readFileSync(store, "utf8").trim().split("\n").at(-1));
      expect(rec.evidence).toContainEqual({ kind: "file_line", ref: "kit/workflows/loop-iteration.js", result: `<loop-denylist> sha256=${CURRENT_DENYLIST}` });
      expect(JSON.parse(trace(["l3-check", "--json"]).stdout)).toMatchObject({ ok: true, denylistRecordHash: CURRENT_DENYLIST, denylistCurrentHash: CURRENT_DENYLIST });
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
    it("two results files scored together (the good fixtures at repeat 2, the whole manifest at repeat 1) count only the fixtures measured in every repeat: l3-check exits 1 on the full-manifest condition alone", () => {
      const m = readBench();
      const good = (f) => f.kind === "good";
      const PART = RUN;
      const FULL = "4e5f6a7b";
      const results = (runId, fixtures, repeats) => {
        const file = join(dir, `runs-${runId}.json`);
        const runs = fixtures.flatMap((f) => Array.from({ length: repeats }, (_, repeat) => ({ arm: "verifier", repeat, fixtureId: opaqueFixtureId(f.id), verdict: "defer", failedGates: [], missing: ["x"] })));
        writeFileSync(file, JSON.stringify({ runId, runs }));
        return file;
      };
      const files = [results(PART, m.fixtures.filter(good), 2), results(FULL, m.fixtures, 1)];
      const tdir = writeTranscripts([...covering({ fixtures: m.fixtures.filter(good) }, PART, 2), ...covering(m, FULL, 1)]);
      expect(trace(["bench-score", ...files, "--transcripts", tdir, "--record"]).status).toBe(0);
      const rec = JSON.parse(readFileSync(store, "utf8").trim().split("\n").at(-1));
      expect(rec.final_status).toBe("accept");
      const metrics = JSON.parse(rec.evidence.find((e) => e.kind === "measurement").result);
      const counts = { bad: m.fixtures.filter((f) => !good(f)).length, good: m.fixtures.filter(good).length };
      expect(metrics.fixtures).toEqual(counts);
      expect(metrics.arms.verifier.repeats).toBe(2);
      expect(metrics.arms.verifier.measured).toEqual({ bad: 0, good: counts.good });
      expect(metrics.arms.verifier.perRepeat.map((p) => p.measured)).toEqual([counts, { bad: 0, good: counts.good }]);
      expect(namesCurrentVerifier()).toBe(true);
      const out = trace(["l3-check", "--json"]);
      expect(out.status).toBe(1);
      expect(JSON.parse(out.stdout).unmet).toEqual([expect.stringMatching(new RegExp(`measured 0/${counts.bad} bad and ${counts.good}/${counts.good} good manifest fixtures in every repeat`))]);
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

  it("exits 1 on a record that does not pin the <loop-denylist> block, asking for a re-bench", () => {
    expect(trace(["write", "-"], benchDraft({ denylist: null })).status).toBe(0);
    const json = trace(["l3-check", "--json"]);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout).unmet).toEqual([expect.stringMatching(/no <loop-denylist> hash .*re-bench with \/bench-checkers/)]);
  });

  it("is NOT met when the effective settings show the sandbox off, or the unsandboxed fallback not held closed at user scope — the bench alone is not enough", () => {
    expect(trace(["write", "-"], benchDraft()).status).toBe(0);
    const home = join(dir, "claude-home");
    mkdirSync(home);
    const off = trace(["l3-check", "--json"], undefined, { CLAUDE_CONFIG_DIR: home }); // no settings at all
    expect(off.status).toBe(1);
    const res = JSON.parse(off.stdout);
    expect(res).toMatchObject({ ok: false, sandbox: { ok: false, enabled: false, heldBy: null } });
    expect(res.unmet).toEqual([expect.stringMatching(/^the sandbox is off/), expect.stringMatching(/^sandbox\.allowUnsandboxedCommands is not held false at user scope/)]);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    const open = trace(["l3-check", "--json"], undefined, { CLAUDE_CONFIG_DIR: home });
    expect(open.status).toBe(1);
    expect(JSON.parse(open.stdout).unmet).toEqual([expect.stringMatching(/^sandbox\.allowUnsandboxedCommands is not held false at user scope/)]);
    const text = trace(["l3-check"], undefined, { CLAUDE_CONFIG_DIR: home });
    expect(text.status).toBe(1);
    expect(text.stdout).toMatch(/^l3-check: NOT met/);
    expect(text.stdout).toMatch(/allowUnsandboxedCommands is not held false/);
    const met = trace(["l3-check"]);
    expect(met.status).toBe(0);
    expect(met.stdout).toMatch(/sandbox on \(user\), unsandboxed fallback held closed \(user\)/);
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
  // Its loop workspace sits OUTSIDE the checkout (as an installed one does) and holds only the wiki's
  // policy page, rec comments included: no index.md or quarantine.md (tolerated).
  const ws = mkdtempSync(join(tmpdir(), "trace-ws-"));
  mkdirSync(join(ws, "topics"), { recursive: true });
  writeFileSync(join(ws, "topics/trace.md"), readFileSync(join(WORKSPACE, "topics/trace.md")));
  mkdirSync(join(d, ".claude"), { recursive: true });
  const copy = (rel) => {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), readFileSync(join(ROOT, rel)));
  };
  for (const f of ["lib.mjs", "cli.mjs", "chain.mjs", "landed.mjs", "bench-judge.mjs", "plan.mjs", "story-map.mjs"]) copy(`kit/trace/${f}`);
  // The CLI's kit/setup imports (the dispatch gates verify the kit through verifykit.mjs and its adapters).
  for (const f of ["layout.mjs", "facts.mjs", "anchors.mjs", "kitfiles.mjs", "kittree.mjs", "integrity.mjs", "verifykit.mjs", "kitremote.mjs", "install.mjs", "settings.mjs", "sandbox.mjs", "guard.mjs"]) copy(`kit/setup/${f}`);
  for (const f of ["kit/workflows/loop-iteration.js", "kit/schema/schema-v1.json", "kit/rules/trace-policy.md"]) copy(f);
  const bundle = join(d, "kit/bench/fixtures.bundle");
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
    spawnSync(process.execPath, [join(d, "kit/trace/cli.mjs"), ...args], { cwd: d, encoding: "utf8", input, env: { ...process.env, TRACE_STORE: join(d, "store.jsonl"), LOOP_SETUP_WORKSPACE: ws, CLAUDE_CONFIG_DIR: SANDBOX_HOME } });
  const cleanup = () => {
    rmSync(d, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  };
  return { d, ws, git, cli, setBundle, cleanup };
}

describe("CLI wiring, end to end in a throwaway repo", () => {
  it("denylist-check reads the denylist from HEAD — a weakened working-tree copy cannot pass a protected path", () => {
    const r = tempRepo();
    try {
      const wf = join(r.d, "kit/workflows/loop-iteration.js");
      const src = readFileSync(wf, "utf8");
      const weakened = src.replace("const hitsDenylist = (files) =>", "const hitsDenylist = () => false; const unusedDenylist = (files) =>");
      expect(weakened).not.toBe(src);
      writeFileSync(wf, weakened); // uncommitted: HEAD still has the real denylist
      const p = join(r.d, "x.patch");
      writeFileSync(p, "diff --git a/kit/loop.md b/kit/loop.md\n--- a/kit/loop.md\n+++ b/kit/loop.md\n@@ -1 +1 @@\n-a\n+b\n");
      expect(r.cli(["denylist-check", "--patch", p]).status).toBe(1);
    } finally {
      r.cleanup();
    }
  });

  // The repository's own configuration files, as the workflow gate's HIT/CLEAR lists say
  // (kit/trace/workflows.test.mjs): a .gitignore or .gitattributes at any depth (git honours a nested
  // one for its subtree), the rest at the root only, so a nested .mcp.json under src/ stays open.
  it("denylist-check escalates .gitignore and .gitattributes at any depth and the root .worktreeinclude, .mcp.json, pnpm-workspace.yaml and next.config.*, and leaves a nested .mcp.json open", () => {
    const r = tempRepo();
    try {
      const edit = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`;
      const check = (f) => {
        const p = join(r.d, "x.patch");
        writeFileSync(p, edit(f));
        const out = r.cli(["denylist-check", "--patch", p]);
        return [f, out.status, JSON.parse(out.stdout).hits];
      };
      const root = [".gitignore", ".gitattributes", ".worktreeinclude", ".mcp.json", "pnpm-workspace.yaml", "next.config.mjs"];
      expect(root.map(check)).toEqual(root.map((f) => [f, 1, [f]]));
      const nested = ["src/.gitignore", "e2e/.gitattributes"];
      expect(nested.map(check)).toEqual(nested.map((f) => [f, 1, [f]]));
      const open = ["src/app/.mcp.json", "src/next.config.ts", "packages/a/pnpm-workspace.yaml"];
      expect(open.map(check)).toEqual(open.map((f) => [f, 0, []]));
    } finally {
      r.cleanup();
    }
  });

  // The same rules on REAL patches, captured the way the loop's implementer captures its diff
  // (`git add -N .`, then `git diff --src-prefix=a/ --dst-prefix=b/`; loop-iteration.js), not hand-written
  // ones: one change at a time on a committed base tree, then denylist-check on that patch.
  it("denylist-check reports a real git diff that adds, edits, renames or deletes a nested .gitignore or .gitattributes, or edits pnpm-workspace.yaml or a root next.config.*, in hits (exit 1), and passes src/ and e2e/ code and a nested .mcp.json (exit 0)", () => {
    const r = tempRepo();
    const out = mkdtempSync(join(tmpdir(), "trace-patch-"));
    const put = (files) => {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(dirname(join(r.d, f)), { recursive: true });
        writeFileSync(join(r.d, f), text);
      }
    };
    try {
      put({
        "src/a.ts": "export const a = 1;\n",
        "src/.gitignore": "*.log\n",
        "e2e/smoke.spec.ts": "export const smoke = 1;\n",
        "e2e/.gitattributes": "*.png binary\n",
        "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - sharp\n",
        "next.config.mjs": "export default { reactStrictMode: true };\n",
      });
      r.git("add", "-A");
      r.git("commit", "-qm", "base");
      // change() edits the working tree; the patch is what git prints for it, then the base tree is restored.
      // The implementer's capture drops a tracked file's deletion: `git add -N .` stages the removal, so
      // the worktree-vs-index diff no longer shows it (git 2.43), and a rename keeps only its new side.
      // The rename and delete cases therefore diff against HEAD (`git diff HEAD -M`), the patch a
      // hand-made change carries; its rename section names both sides.
      const IMPLEMENTER = ["diff", "--src-prefix=a/", "--dst-prefix=b/"];
      const HEAD_M = ["diff", "HEAD", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
      const check = (change, diffArgs = IMPLEMENTER) => {
        change();
        r.git("add", "-N", ".");
        const diff = r.git(...diffArgs);
        r.git("reset", "-q");
        r.git("checkout", "--", ".");
        r.git("clean", "-fdq", "--", "src", "e2e", "next.config.ts");
        const p = join(out, "x.patch");
        writeFileSync(p, diff.stdout);
        const res = r.cli(["denylist-check", "--patch", p]);
        const body = JSON.parse(res.stdout);
        return [diff.status, res.status, body.paths, body.hits];
      };
      const hit = [
        ["a new src/app/.gitignore that ignores everything but itself", () => put({ "src/app/.gitignore": "*\n!.gitignore\n" }), ["src/app/.gitignore"]],
        ["a new e2e/fixtures/.gitattributes", () => put({ "e2e/fixtures/.gitattributes": "*.ts -diff\n" }), ["e2e/fixtures/.gitattributes"]],
        ["an edit to src/.gitignore", () => put({ "src/.gitignore": "*.log\nlater.ts\n" }), ["src/.gitignore"]],
        ["a renamed src/.gitignore", () => renameSync(join(r.d, "src/.gitignore"), join(r.d, "src/ignore.txt")), ["src/.gitignore"], HEAD_M],
        ["a deleted e2e/.gitattributes", () => rmSync(join(r.d, "e2e/.gitattributes")), ["e2e/.gitattributes"], HEAD_M],
        ["an edit to pnpm-workspace.yaml", () => put({ "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - sharp\n  - some-native-dep\n" }), ["pnpm-workspace.yaml"]],
        ["an edit to next.config.mjs", () => put({ "next.config.mjs": "export default { reactStrictMode: false };\n" }), ["next.config.mjs"]],
        ["a new next.config.ts", () => put({ "next.config.ts": "export default {};\n" }), ["next.config.ts"]],
      ];
      const got = hit.map(([name, change, , diffArgs]) => [name, ...check(change, diffArgs)]);
      // paths: git's own parse of the patch (both sides of a rename); hits: exactly the protected ones.
      expect(got.map(([name, gitStatus, status, , hits]) => [name, gitStatus, status, hits])).toEqual(hit.map(([name, , hits]) => [name, 0, 1, hits]));
      expect(got.find(([name]) => name === "a renamed src/.gitignore")[3].sort()).toEqual(["src/.gitignore", "src/ignore.txt"]);
      const clear = [
        ["an edit to src/a.ts", () => put({ "src/a.ts": "export const a = 2;\n" }), ["src/a.ts"]],
        ["an edit to e2e/smoke.spec.ts", () => put({ "e2e/smoke.spec.ts": "export const smoke = 2;\n" }), ["e2e/smoke.spec.ts"]],
        ["a new src/app/.mcp.json", () => put({ "src/app/.mcp.json": "{}\n" }), ["src/app/.mcp.json"]],
      ];
      expect(clear.map(([name, change]) => [name, ...check(change)])).toEqual(clear.map(([name, , paths]) => [name, 0, 0, paths, []]));
    } finally {
      rmSync(out, { recursive: true, force: true });
      r.cleanup();
    }
  });

  // Parity with the workflow gate: the same corpus (kit/test/denylist-modes.mjs) and the same answer.
  it("denylist-check escalates every corpus patch that writes a symlink, a gitlink or a mode change (exit 1, listed in hits and modeHits) and passes the rest", () => {
    const r = tempRepo();
    try {
      const p = join(r.d, "x.patch");
      const got = MODE_PATCHES.map((c) => {
        writeFileSync(p, c.patch);
        const out = r.cli(["denylist-check", "--patch", p]);
        const body = out.stdout ? JSON.parse(out.stdout) : {};
        return [c.name, out.status, body.hits, body.modeHits];
      });
      expect(got).toEqual(MODE_PATCHES.map((c) => [c.name, c.hits.length ? 1 : 0, c.hits, c.hits]));
    } finally {
      r.cleanup();
    }
  });

  // A rename, a copy or a retarget of an EXISTING symlink or gitlink carries no mode line (git takes the
  // mode from the preimage), so the patch text cannot show it: denylist-check reads HEAD's mode of every
  // path git finds in the patch (both sides). The workflow gate has no tree; this check is the CLI's.
  it("denylist-check escalates a patch that touches an existing symlink or gitlink in HEAD: a rename, a copy or a retarget with no mode line", () => {
    const r = tempRepo();
    try {
      mkdirSync(join(r.d, "src"), { recursive: true });
      symlinkSync("../kit/loop.md", join(r.d, "src/link"));
      writeFileSync(join(r.d, "src/a.ts"), "a\n");
      r.git("add", "-A");
      r.git("update-index", "--add", "--cacheinfo", `160000,${r.git("rev-parse", "HEAD").stdout.trim()},src/vendor`);
      r.git("commit", "-qm", "a symlink, a gitlink and a regular file");
      const staged = (prep, ...diffArgs) => {
        prep();
        const out = r.git("diff", "--cached", "--src-prefix=a/", "--dst-prefix=b/", ...diffArgs).stdout;
        r.git("reset", "-q", "--hard", "HEAD");
        return out;
      };
      const rename = staged(() => r.git("mv", "src/link", "src/moved"), "-M");
      const copy = staged(() => {
        symlinkSync("../kit/loop.md", join(r.d, "src/copy"));
        r.git("add", "src/copy");
      }, "-C", "--find-copies-harder");
      const retarget = "diff --git a/src/link b/src/link\n--- a/src/link\n+++ b/src/link\n@@ -1 +1 @@\n-../kit/loop.md\n\\ No newline at end of file\n+../../outside\n\\ No newline at end of file\n";
      const gitlink = "diff --git a/src/vendor b/src/vendor2\nsimilarity index 100%\nrename from src/vendor\nrename to src/vendor2\n";
      const plain = staged(() => r.git("mv", "src/a.ts", "src/b.ts"), "-M");
      for (const [name, patch] of [["rename", rename], ["copy", copy]]) expect(patch, name).not.toMatch(/^(new file|old|new) mode|^index /m); // no mode line: only the tree can tell
      const p = join(r.d, "x.patch");
      const check = (name, patch) => {
        writeFileSync(p, patch);
        const out = r.cli(["denylist-check", "--patch", p]);
        const body = JSON.parse(out.stdout);
        return [name, out.status, body.hits, body.modeHits];
      };
      expect([check("rename", rename), check("copy", copy), check("retarget", retarget), check("gitlink", gitlink), check("plain", plain)]).toEqual([
        ["rename", 1, ["src/link"], ["src/link"]],
        ["copy", 1, ["src/link"], ["src/link"]],
        ["retarget", 1, ["src/link"], ["src/link"]],
        ["gitlink", 1, ["src/vendor"], ["src/vendor"]],
        ["plain", 0, [], []],
      ]);
    } finally {
      r.cleanup();
    }
  });

  it("denylist-check fails closed (exit 2) when the trusted copy of the denylist block has no mode rule", () => {
    const r = tempRepo();
    try {
      const wf = join(r.d, "kit/workflows/loop-iteration.js");
      const src = readFileSync(wf, "utf8");
      const old = src.replace(/\bdiffModeHits\b/g, "olderName");
      expect(old).not.toBe(src);
      writeFileSync(wf, old);
      r.git("commit", "-qam", "a denylist block from before the mode rule");
      const p = join(r.d, "x.patch");
      writeFileSync(p, MODE_PATCHES.find((c) => !c.hits.length).patch);
      const out = r.cli(["denylist-check", "--patch", p]);
      expect(out.status).toBe(2);
      expect(JSON.parse(out.stdout).error).toMatch(/could not verify the patch/);
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

  it("l3-check hashes the working tree's <loop-denylist> block too: an edit inside it after the bench fails the record with an explicit reason", () => {
    const r = tempRepo();
    try {
      expect(r.cli(["write", "-"], benchDraft()).status).toBe(0);
      expect(r.cli(["l3-check"]).status).toBe(0);
      const wf = join(r.d, "kit/workflows/loop-iteration.js");
      const src = readFileSync(wf, "utf8");
      const weakened = src.replace("/^kit(\\/|$)/i, ", "");
      expect(weakened).not.toBe(src);
      expect(denylistSha(weakened)).not.toBe(CURRENT_DENYLIST);
      expect(verifierSha(weakened)).toBe(CURRENT_VERIFIER); // only the denylist changed
      writeFileSync(wf, weakened);
      const edited = r.cli(["l3-check", "--json"]);
      expect(edited.status).toBe(1);
      expect(JSON.parse(edited.stdout).unmet).toEqual([expect.stringMatching(/another <loop-denylist> block .*the denylist changed after the bench: re-bench with \/bench-checkers/)]);
    } finally {
      r.cleanup();
    }
  });

  it("l3-check hashes the working tree's <loop-verifier> block: an edit inside it fails a matching record, an edit outside it does not, a missing file fails closed", () => {
    const r = tempRepo();
    try {
      expect(r.cli(["write", "-"], benchDraft()).status).toBe(0); // the copy's block hashes like the real one
      expect(r.cli(["l3-check"]).status).toBe(0);
      const wf = join(r.d, "kit/workflows/loop-iteration.js");
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

  it("reaudit --claim-prefix story: lists (and --act notes) only the story-status claims whose evidence changed", () => {
    const r = tempRepo();
    try {
      mkdirSync(join(r.d, "src"), { recursive: true });
      writeFileSync(join(r.d, "src", "a.ts"), "export const a = 1;\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "cited file");
      const fact = (claim) => JSON.stringify({ writer_id: "test", claim_id: claim, claim_text: claim, claim_type: "factual", evidence: [{ kind: "file_line", ref: "src/a.ts:1" }], final_status: "accept", reason: "r", provenance: { workflow: "test" } });
      for (const c of ["story:us-001:status", "cli:other"]) expect(r.cli(["write", "-"], fact(c)).status).toBe(0);
      writeFileSync(join(r.d, "src", "a.ts"), "export const a = 2;\n");
      expect(JSON.parse(r.cli(["reaudit"]).stdout).map((c) => c.claim_id).sort()).toEqual(["cli:other", "story:us-001:status"]);
      const only = r.cli(["reaudit", "--claim-prefix", "story:"]);
      expect(only.status).toBe(0);
      expect(JSON.parse(only.stdout).map((c) => c.claim_id)).toEqual(["story:us-001:status"]);
      expect(r.cli(["reaudit", "--claim-prefix", "story:", "--act"]).status).toBe(0);
      const acted = readFileSync(join(r.d, "store.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "action");
      expect(acted).toHaveLength(1);
      expect(r.cli(["reaudit", "--claim-prefix"]).status).toBe(2); // a missing prefix is a usage error
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
      // M6: --unreachable keeps only the squashed-away provenance; --annotate prints a GitHub warning per record, exit 0.
      const unreach = r.cli(["reaudit", "--unreachable", "--annotate"]);
      expect(unreach.status).toBe(0);
      expect(unreach.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^::warning title=TRACE provenance unreachable::cli:squashed .*squash/)]);
      expect(r.cli(["reaudit", "--act"]).status).toBe(0);
      const notes = readFileSync(join(r.d, "store.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "action").map((a) => a.note);
      expect(notes.sort()).toEqual(["evidence changed: src/b.ts", `provenance commit ${byClaim["cli:squashed"].unreachable} is unreachable — re-verify: src/a.ts`]);
    } finally {
      r.cleanup();
    }
  });

  it("wiki-check: the template's rec comments over an empty store name no record (exit 1) until stripped (exit 0, and a size warning alone still exits 0); a store that does not replay exits 2", () => {
    const r = tempRepo(); // its workspace holds only the policy page: no index.md or quarantine.md (tolerated)
    try {
      const policy = join(r.ws, "topics/trace.md");
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
      writeFileSync(join(r.ws, "topics/big.md"), Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
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

// The adapter end to end where a split commit is NOT in the repository (a throwaway repo, as in a shallow
// clone): merge-base exits 128, the order is unknown, and the record is told to re-verify rather than
// being compared with one half of the split file.
describe("reaudit where the split commit is not in the repository", () => {
  it("lists a CLAUDE.md citation as split at 4ccf257 (unknown order counts as older), and --act clears it", () => {
    const r = tempRepo();
    try {
      // The kit's own source repo (kit/kit.json names loop-setup), shallow: the split commit is missing.
      writeFileSync(join(r.d, "CLAUDE.md"), "# rules\n");
      writeFileSync(join(r.d, "kit/kit.json"), JSON.stringify({ name: "loop-setup" }));
      r.git("add", "CLAUDE.md", "kit/kit.json");
      r.git("commit", "-qm", "rules");
      expect(r.git("cat-file", "-e", "4ccf257^{commit}").status).not.toBe(0);
      const d = join(r.d, "d.json");
      writeFileSync(d, draft({ claim_id: "c:rules", evidence: [{ kind: "file_line", ref: "CLAUDE.md:1", result: "x" }] }));
      expect(r.cli(["write", d]).status).toBe(0);
      const first = r.cli(["reaudit"]);
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual([expect.objectContaining({ claim_id: "c:rules", split: [{ path: "CLAUDE.md", at: "4ccf257", note: "split at 4ccf257 — re-verify" }] })]);
      expect(r.cli(["reaudit", "--act"]).status).toBe(0);
      expect(JSON.parse(r.cli(["reaudit"]).stdout)).toEqual([]);
    } finally {
      r.cleanup();
    }
  });
});

// An adopter project (no kit/kit.json naming loop-setup) cites its own CLAUDE.md, .claude/commands/ and
// scripts/hooks/ files: the kit move's facts are not its history, so each is diffed in place — no split,
// no "unmapped → changed" — and a real edit is still listed as changed.
describe("reaudit in an adopter project", () => {
  it("diffs the project's own CLAUDE.md, .claude/commands/ and scripts/hooks/ files in place: unchanged ones are not listed, an edited one is changed", () => {
    const r = tempRepo();
    try {
      for (const [f, text] of [["CLAUDE.md", "# rules\n"], [".claude/commands/own.md", "own\n"], ["scripts/hooks/own.mjs", "export {};\n"]]) {
        mkdirSync(dirname(join(r.d, f)), { recursive: true });
        writeFileSync(join(r.d, f), text);
      }
      r.git("add", "CLAUDE.md", ".claude/commands/own.md", "scripts/hooks/own.mjs");
      r.git("commit", "-qm", "own files");
      expect(existsSync(join(r.d, "kit/kit.json"))).toBe(false);
      const d = join(r.d, "d.json");
      const ev = ["CLAUDE.md:1", ".claude/commands/own.md:1", "scripts/hooks/own.mjs:1"].map((ref) => ({ kind: "file_line", ref, result: "x" }));
      writeFileSync(d, draft({ claim_id: "c:own", evidence: ev }));
      expect(r.cli(["write", d]).status).toBe(0);
      const clean = r.cli(["reaudit"]);
      expect(clean.status, clean.stderr).toBe(0);
      expect(JSON.parse(clean.stdout)).toEqual([]);
      writeFileSync(join(r.d, ".claude/commands/own.md"), "edited\n");
      expect(JSON.parse(r.cli(["reaudit"]).stdout)).toEqual([expect.objectContaining({ claim_id: "c:own", changed: [".claude/commands/own.md"] })]);
    } finally {
      r.cleanup();
    }
  });
});

// reaudit over the frozen pre-move store (kit/test/fixtures/legacy-v1) in a full-history clone of this
// repository, the code under test being this working tree's CLI. No "evidence changed" entry may be one
// whose content did not change: an independent oracle (git show at the record's commit against the
// file's current home) checks each. The split topics/trace.md (its policy half went to
// kit/rules/trace-policy.md at ec6d24b) is listed once as split, never as changed, and --act clears it.
describe("reaudit over the legacy-v1 fixture store in a full-history clone", () => {
  it("reports no unchanged file as changed, lists the split topics/trace.md once as split at ec6d24b, and a REAUDIT from --act clears it", () => {
    expect(spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(), "this test needs full git history (git fetch --unshallow)").toBe("false");
    const d = mkdtempSync(join(tmpdir(), "trace-reaudit-"));
    const home = mkdtempSync(join(tmpdir(), "trace-reaudit-home-"));
    try {
      const clone = join(d, "repo");
      expect(spawnSync("git", ["clone", "-q", "--no-local", ROOT, clone]).status).toBe(0);
      const ws = join(clone, "kit/test/fixtures/legacy-v1");
      const storeCopy = join(d, "records.jsonl");
      copyFileSync(join(ws, "trace/records.jsonl"), storeCopy);
      const run = (...args) =>
        spawnSync(process.execPath, [CLI, "reaudit", "--store", storeCopy, ...args], { cwd: clone, encoding: "utf8", env: { ...process.env, LOOP_SETUP_WORKSPACE: ws, CLAUDE_CONFIG_DIR: home, TRACE_STORE: storeCopy } });
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      const cands = JSON.parse(first.stdout);
      const records = Object.fromEntries(
        readFileSync(storeCopy, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "record").map((r) => [r.record_id, r]),
      );
      const changed = cands.filter((c) => c.changed).flatMap((c) => c.changed.map((p) => [c.record_id, p]));
      expect(changed.length).toBeGreaterThan(0);
      const unchangedButReported = changed.filter(([id, p]) => {
        const ref = resolveLegacyRef(p, { roots: [clone] });
        const then = spawnSync("git", ["show", `${records[id].provenance.commit}:${ref.path}`], { cwd: clone }).stdout;
        const file = ref.target && (ref.target.root === "workspace" ? join(ws, ref.target.path) : join(clone, ref.target.path));
        return !!file && existsSync(file) && then.length > 0 && Buffer.compare(then, readFileSync(file)) === 0;
      });
      expect(unchangedButReported).toEqual([]);
      // Positive side: an absolute ref whose content did change is read repo-relative and listed as changed.
      expect(changed).toContainEqual(["TR-cb3baca81e27", "/home/user/loop-setup/scripts/trace/lib.mjs"]);
      // The split file, cited by absolute path from a record older than the split.
      const splits = cands.filter((c) => c.split).flatMap((c) => c.split.map((s) => `${c.record_id} ${s.path} ${s.at} ${s.note}`));
      expect(splits).toContain("TR-cb3baca81e27 /home/user/loop-setup/.claude/memory/topics/trace.md ec6d24b split at ec6d24b — re-verify");
      expect(changed.filter(([, p]) => p.endsWith(".claude/memory/topics/trace.md"))).toEqual([]);
      // --act records a REAUDIT per split path; the next run lists no split, and the real changes stay.
      const acted = run("--act");
      expect(acted.status, acted.stderr).toBe(0);
      const second = JSON.parse(run().stdout);
      expect(second.filter((c) => c.split)).toEqual([]);
      expect(second.filter((c) => c.changed).flatMap((c) => c.changed.map((p) => [c.record_id, p]))).toEqual(changed);
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
