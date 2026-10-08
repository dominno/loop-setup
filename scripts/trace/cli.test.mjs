// The sanctioned writer is the CLI, so test it as a process: exit codes, fail-closed
// paths, and the bench-judge safety helpers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opaqueFixtureId, readBench, ROOT } from "./lib.mjs";
import { appliedFixtures, benchPreconditionStep, benchPreflight, judgeEnv, runBenchJudge, runJudge, SIGNALS } from "./bench-judge.mjs";

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
  // Gone, or a zombie waiting to be reaped (some containers never reap orphans).
  const dead = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z");
    } catch {
      return true;
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
      expect(await runJudge(j.command, { timeoutMs: 400, onChild: (c) => (child = c) })).toBeNull();
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

  it("reaudit --act twice on an unchanged queue appends the REAUDIT once", () => {
    trace(["write", "-"], draft({ evidence: [{ kind: "file_line", ref: "package.json:1" }], provenance: { workflow: "test", commit: "deadbeef0000" } }));
    const lines = () => readFileSync(store, "utf8").trim().split("\n").length;
    expect(trace(["reaudit", "--act"]).status).toBe(0);
    expect(lines()).toBe(2);
    expect(trace(["reaudit", "--act"]).status).toBe(0);
    expect(lines()).toBe(2);
    expect(JSON.parse(readFileSync(store, "utf8").trim().split("\n")[1])).toMatchObject({ action: "REAUDIT", note: "evidence changed: package.json" });
  });

  it("act --from records BOTH actions and reuseActions when a result carries both", () => {
    trace(["write", "-"], draft());
    const id = JSON.parse(trace(["query", "--json"]).stdout)[0].record_id;
    const file = join(dir, "both.json");
    writeFileSync(file, JSON.stringify({ actions: [], reuseActions: [{ record_id: id, consumer: "critic-panel", action: "REUSE", note: "n" }] }));
    expect(trace(["act", "--from", file]).status).toBe(0);
    expect(JSON.parse(trace(["show", id]).stdout).actions).toHaveLength(1);
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
    const setup = (transcripts, { runId = RUN } = {}) => {
      const m = readBench();
      const runs = join(dir, "runs.json");
      writeFileSync(runs, JSON.stringify({ ...(runId ? { runId } : {}), runs: m.fixtures.map((f) => ({ arm: "verifier", repeat: 0, fixtureId: opaqueFixtureId(f.id), verdict: "defer", failedGates: [], missing: ["x"] })) }));
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
    const covering = (m, run = RUN) => m.fixtures.map((f, i) => ({ label: `bench-verify:${opaqueFixtureId(f.id)}-r0-${i}@${run}`, text: "clean" }));
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
