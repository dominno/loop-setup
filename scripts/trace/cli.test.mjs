// The sanctioned writer is the CLI, so test it as a process: exit codes, fail-closed
// paths, and the bench-judge safety helpers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { judgeEnv, runJudge } from "./bench-judge.mjs";

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

describe("bench-judge safety helpers", () => {
  it("judges run with an allowlisted environment — no tokens or proxy credentials", () => {
    const env = judgeEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y", HTTPS_PROXY: "z" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", CI: "true" });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["GITHUB_TOKEN"]));
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("a judge that could not run is 'not observed', never 'caught'", () => {
    expect(runJudge("x", { spawn: () => ({ error: new Error("ENOENT"), status: null }) })).toBeNull();
    expect(runJudge("x", { spawn: () => ({ status: null, signal: "SIGTERM" }) })).toBeNull();
    expect(runJudge("x", { spawn: () => ({ status: 1 }) })).toBe(true);
    expect(runJudge("x", { spawn: () => ({ status: 0 }) })).toBe(false);
  });
});
