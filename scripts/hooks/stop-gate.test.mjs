// The opt-in stop-gate Stop hook (.claude/hooks/stop-gate.mjs): its pure decision and mode tables,
// then the real gate end to end in throwaway git repos (the tempRepo pattern from
// scripts/trace/cli.test.mjs) with an injected runner stub: a node process stands in for vitest, so
// the fingerprint, manifest, lock, deadline and kill paths all run for real.
import { describe, it, expect, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, GLOBAL_GATES, GRACE_MS, planRun, run, spawnCommand, TIMEOUT_MS } from "../../.claude/hooks/stop-gate.mjs";
import { TREE_ID_EXCLUDES } from "../trace/lib.mjs";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../.claude/hooks/stop-gate.mjs");
const FULL = [["pnpm", "exec", "vitest", "run", "--maxWorkers=2"]];
const stopInput = (cwd, over = {}) => ({ session_id: "s1", cwd, hook_event_name: "Stop", stop_hook_active: false, background_tasks: [], ...over });

describe("decide()", () => {
  const task = (over) => ({ id: "t1", status: "running", description: "", ...over });
  const withTask = (over) => stopInput("/repo", { background_tasks: [task(over)] });
  // [case, expected run, input, env, lock holder]: the expected value comes second, so each title reads
  // "<case> → run <expected>".
  it.each([
    ["STOP_GATE=0", false, stopInput("/repo"), { STOP_GATE: "0" }, null],
    // The snippet pasted under another event: SubagentStop fires after every foreground subagent, a
    // tool event on every call.
    ["a SubagentStop input", false, stopInput("/repo", { hook_event_name: "SubagentStop" }), {}, null],
    ["a tool-event input", false, stopInput("/repo", { hook_event_name: "PostToolUse", tool_name: "Edit" }), {}, null],
    ["a Stop input without hook_event_name", true, stopInput("/repo", { hook_event_name: undefined }), {}, null],
    ["stop_hook_active", false, stopInput("/repo", { stop_hook_active: true }), {}, null],
    ["another session's live gate holds the lock", false, stopInput("/repo"), {}, { session_id: "s2", pid: 4242 }],
    ["a workflow background task", false, withTask({ type: "workflow", name: "critic-panel", description: "critic round" }), {}, null],
    ["a subagent", false, withTask({ type: "subagent", agent_type: "general-purpose", description: "Explore the repo" }), {}, null],
    ["a teammate", false, withTask({ type: "teammate", description: "Draft the copy" }), {}, null],
    ["a cloud session", false, withTask({ type: "cloud session", description: "Port the page" }), {}, null],
    // Keyed on presence: an unknown status still counts, because the status values are undocumented.
    ["a workflow in an unknown status", false, withTask({ type: "workflow", status: "settling", name: "scan-docs" }), {}, null],
    ["a shell task mentioning vitest", false, withTask({ type: "shell", command: "pnpm exec vitest run", description: "Run the unit suite" }), {}, null],
    ["a shell task running a bench judge", false, withTask({ type: "shell", command: "pnpm trace bench-judge", description: "Judge the fixtures" }), {}, null],
    // Each of these mentions exactly one of the words, so every word is pinned on its own ("vitest"
    // contains "test").
    ["a shell task running pnpm test", false, withTask({ type: "shell", command: "pnpm test", description: "Unit suite" }), {}, null],
    ["a shell task running the E2E suite", false, withTask({ type: "shell", command: "pnpm test:e2e", description: "E2E run" }), {}, null],
    ["a shell task naming Playwright", false, withTask({ type: "shell", command: "pnpm e2e --headed", description: "Run Playwright headed" }), {}, null],
    ["a shell task running pnpm verify", false, withTask({ type: "shell", command: "pnpm verify", description: "Full check chain" }), {}, null],
    ["a shell task running a trace command", false, withTask({ type: "shell", command: "pnpm trace wiki-check", description: "Wiki agreement" }), {}, null],
    ["a shell task naming a bench", false, withTask({ type: "shell", command: "node judge.mjs", description: "Score the bench fixtures" }), {}, null],
    ["a shell task running pnpm dev", true, withTask({ type: "shell", command: "pnpm dev", description: "Start the dev server" }), {}, null],
    ["no background work", true, stopInput("/repo"), {}, null],
  ])("%s → run %s", (_, expected, input, env, holder) => {
    expect(decide(input, env, holder).run).toBe(expected);
  });
});

describe("planRun()", () => {
  it("the default is the full unit suite; only STOP_GATE_MODE=related opts out", () => {
    expect(planRun({ changed: ["src/lib/greeting.ts"] })).toEqual({ mode: "full", commands: FULL });
    expect(planRun({ mode: "fast", changed: ["src/lib/greeting.ts"] })).toEqual({ mode: "full", commands: FULL });
  });

  it("related mode with only src/lib/greeting.ts runs vitest related on it plus the global gates", () => {
    expect(GLOBAL_GATES).toContain("scripts/trace/contracts.test.mjs");
    expect(planRun({ mode: "related", changed: ["src/lib/greeting.ts"] })).toEqual({
      mode: "related",
      commands: [
        ["pnpm", "exec", "vitest", "related", "src/lib/greeting.ts", "--run", "--maxWorkers=1"],
        ["pnpm", "exec", "vitest", "run", ...GLOBAL_GATES, "--maxWorkers=1"],
      ],
    });
  });

  // cli.test.mjs reads README.md and the leak guard reads every tracked file, so only src/ is reached
  // through imports alone.
  it.each([[["README.md"]], [["docs/prd.md"]], [["src/lib/greeting.ts", "README.md"]], [[".claude/workflows/loop-iteration.js"]], [["package.json"]], [["scripts/trace/lib.mjs"]]])(
    "related mode with %j runs the full suite",
    (changed) => {
      expect(planRun({ mode: "related", changed })).toEqual({ mode: "full", commands: FULL });
    },
  );

  it("related mode runs the full suite when a changed src/ path is gone (vitest related selects nothing for it) or the changed set is unknown", () => {
    expect(planRun({ mode: "related", changed: ["src/lib/gone.ts"], exists: (p) => p !== "src/lib/gone.ts" })).toEqual({ mode: "full", commands: FULL });
    expect(planRun({ mode: "related", changed: null })).toEqual({ mode: "full", commands: FULL });
  });

  it("related mode leaves out a global gate the project does not have (vitest run on a missing file exits 1, a false red)", () => {
    expect(planRun({ mode: "related", changed: ["src/lib/greeting.ts"], exists: (p) => !GLOBAL_GATES.includes(p) })).toEqual({
      mode: "related",
      commands: [["pnpm", "exec", "vitest", "related", "src/lib/greeting.ts", "--run", "--maxWorkers=1"]],
    });
  });

  it("never plans a build, E2E or a dev server: every command is a vitest unit run", () => {
    for (const { commands } of [planRun({}), planRun({ mode: "related", changed: ["src/lib/greeting.ts"] })]) {
      expect(commands.length).toBeGreaterThan(0);
      for (const argv of commands) {
        expect(argv.slice(0, 3)).toEqual(["pnpm", "exec", "vitest"]);
        expect(["run", "related"]).toContain(argv[3]);
        expect(argv.join(" ")).not.toMatch(/build|e2e|playwright|\bdev\b/);
      }
    }
  });
});

describe("deadlines", () => {
  // 120 s is the hook timeout the documented snippet sets, and the most scripts/trace/config.test.mjs
  // allows a committed hook. The gate has to stop itself first: its worst case is the deadline, the grace
  // period before the SIGKILL and the wait after it, plus a few git calls.
  it("the gate's worst case, TIMEOUT_MS plus two grace periods, ends inside the 120 s hook timeout", () => {
    expect(TIMEOUT_MS).toBe(90_000);
    expect(GRACE_MS).toBe(5_000);
    expect(TIMEOUT_MS + 2 * GRACE_MS).toBeLessThan(120_000);
  });
});

// A throwaway repo with two src/ files, a README and a stand-in for each global gate, committed once.
function tempRepo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "stop-gate-")));
  const git = (...a) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: d, encoding: "utf8" });
  const write = (rel, text) => {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  };
  write("src/lib/a.ts", "export const a = 1;\n");
  write("src/lib/b.ts", "export const b = 1;\n");
  write("README.md", "# temp\n");
  for (const gate of GLOBAL_GATES) write(gate, "// stands in for a path-reading global gate\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const gitPath = (name) => git("rev-parse", "--path-format=absolute", "--git-path", name).stdout.trim();
  const manifest = () => JSON.parse(readFileSync(gitPath("stop-gate.json"), "utf8"));
  const log = () => readFileSync(gitPath("stop-gate.log"), "utf8");
  return { d, git, write, gitPath, manifest, log, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

// The runner stub: records each planned command, its cwd and when it started, and spawns `script` (a
// `node -e` body, or a function of the planned argv that returns one) through `start`, the real
// spawnCommand by default, in place of pnpm. eof[i] turns true once the i-th child's stdout and stderr
// have both reached end-of-file, which happens only after every process holding them has let go of them.
// (The child's 'close' event shows less: the gate destroys the pipes it stops waiting on, and 'close'
// follows.)
function stub(script, start = spawnCommand) {
  const calls = [];
  const cwds = [];
  const started = [];
  const children = [];
  const eof = [];
  const spawner = (argv, opts) => {
    calls.push(argv);
    cwds.push(opts.cwd);
    started.push(Date.now());
    const child = start([process.execPath, "-e", typeof script === "function" ? script(argv) : script], opts);
    const i = children.push(child) - 1;
    let ended = 0;
    eof[i] = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("end", () => {
        eof[i] = ++ended === 2;
      });
    }
    return child;
  };
  return { calls, cwds, started, children, eof, spawner };
}
const GREEN = `console.log(" Test Files  3 passed (3)")`;
const RED = `console.log(" FAIL  src/lib/a.test.ts > greets by name"); console.log(" Test Files  2 failed | 1 passed (3)"); process.exit(1)`;
const CRASH = `console.error("Error: cannot load the config"); process.exit(2)`;
// Ignores SIGTERM, so only a SIGKILL ends it early, and exits by itself after 20 s. The bound exists so
// a killed or failing test run cannot leak it: spawnCommand detaches it from the run's process group,
// so a Ctrl+C, a tool or CI timeout, or a regressed kill path would otherwise leave it running for good.
const STUBBORN = `process.on("SIGTERM", () => {}); setTimeout(() => {}, 20_000)`;
// Leaves an untracked file behind, as a killed cli.test.mjs would, and starts a stubborn grandchild that
// stays in the stub's process group (as pnpm starts vitest, and vitest its workers) and shares its stdout
// and stderr.
const HANG = `require("node:fs").writeFileSync("left-behind.tmp", "x"); require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(STUBBORN)}], { stdio: "inherit" }); ${STUBBORN}`;
// Starts a stray that inherits the stub's stdout and stderr and outlives the stub, as a server a test setup
// forgets to stop: `detached`, in a process group of its own, out of reach of the gate's group kill;
// otherwise in the stub's group. It ignores SIGTERM and lives 5 s at most, and its pid goes to `pidFile`,
// so the test can see it alive and kill it.
const leak = (pidFile, detached) =>
  `const p = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => {}, 5000)`)}], { stdio: "inherit", detached: ${detached} }); p.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(p.pid));`;
const killFrom = (pidFile) => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  } catch {
    // never started, or already gone
  }
};

describe("the gate, end to end in a throwaway repo", () => {
  it("green writes {lastGreen: {head, tree, dirty}}, prints nothing, and keeps its state out of the tree", async () => {
    const r = tempRepo();
    try {
      r.write("src/lib/a.ts", "export const a = 2;\n");
      r.write("src/lib/new.ts", "export const n = 1;\n");
      const s = stub(GREEN);
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner })).toBe("");
      expect(s.calls).toEqual(FULL);
      expect(s.cwds).toEqual([r.d]);
      const head = r.git("rev-parse", "HEAD").stdout.trim();
      expect(r.manifest()).toEqual({ lastGreen: { head, tree: expect.stringMatching(/^[0-9a-f]{16}$/), dirty: ["src/lib/a.ts", "src/lib/new.ts"] } });
      const entries = r.log().trim().split("\n").map((l) => JSON.parse(l));
      expect(entries).toEqual([expect.objectContaining({ mode: "full", outcome: "green", code: 0, failed: 0 })]);
      expect(existsSync(r.gitPath("stop-gate.lock"))).toBe(false);
      expect(r.git("status", "--porcelain", "--untracked-files=all").stdout).not.toMatch(/stop-gate/);
    } finally {
      r.cleanup();
    }
  });

  it("an unchanged tree never calls the runner; any edit runs it again", async () => {
    const r = tempRepo();
    try {
      const s = stub(GREEN);
      const gate = () => run({ input: stopInput(r.d), env: {}, spawner: s.spawner });
      expect(await gate()).toBe("");
      expect(await gate()).toBe("");
      expect(s.calls.length).toBe(1);
      r.write("src/lib/b.ts", "export const b = 2;\n");
      expect(await gate()).toBe("");
      expect(s.calls.length).toBe(2);
    } finally {
      r.cleanup();
    }
  });

  it("new content in an untracked file runs it again: untracked files count by content, not by path alone", async () => {
    const r = tempRepo();
    try {
      const s = stub(GREEN);
      const gate = () => run({ input: stopInput(r.d), env: {}, spawner: s.spawner });
      r.write("src/lib/new.ts", "export const n = 1;\n");
      expect(await gate()).toBe("");
      r.write("src/lib/new.ts", "export const n = 2;\n");
      expect(await gate()).toBe("");
      expect(s.calls.length).toBe(2);
    } finally {
      r.cleanup();
    }
  });

  // `pnpm trace tree-id` leaves these paths out; the gate must not, because tests read them
  // (contracts.test.mjs reads the record store). A directory entry is exercised through a file in it.
  it.each(TREE_ID_EXCLUDES.map((p) => [/\.\w+$/.test(p) ? p : `${p}/records.jsonl`]))("an edit to the tracked %s, which tree-id leaves out, runs it again", async (file) => {
    const r = tempRepo();
    try {
      r.write(file, "one\n");
      r.git("add", "--", file);
      r.git("commit", "-qm", "track");
      const s = stub(GREEN);
      const gate = () => run({ input: stopInput(r.d), env: {}, spawner: s.spawner });
      expect(await gate()).toBe("");
      r.write(file, "two\n");
      expect(await gate()).toBe("");
      expect(s.calls.length).toBe(2);
    } finally {
      r.cleanup();
    }
  });

  it("red twice on the same tree gives one message, with counts only (never a test name)", async () => {
    const r = tempRepo();
    try {
      r.write("src/lib/a.ts", "export const a = 3;\n");
      const s = stub(RED);
      const gate = () => run({ input: stopInput(r.d), env: {}, spawner: s.spawner });
      const first = await gate();
      expect(first.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(first)).toEqual({ systemMessage: "stop-gate: 2 unit test file(s) failing — advisory; run pnpm test" });
      expect(await gate()).toBe("");
      expect(s.calls.length).toBe(1);
      expect(r.manifest()).toEqual({ lastReported: { tree: expect.stringMatching(/^[0-9a-f]{16}$/), outcome: "red" } });
      expect(r.log()).toMatch(/"outcome":"red","code":1,"failed":2/);
      expect(first + r.log()).not.toMatch(/a\.test\.ts|greets/);
    } finally {
      r.cleanup();
    }
  });

  it("a green run clears what was reported: red, then green, then the red tree again warns again", async () => {
    const r = tempRepo();
    try {
      const red = stub(RED);
      const green = stub(GREEN);
      const gate = (s) => run({ input: stopInput(r.d), env: {}, spawner: s.spawner });
      const warning = { systemMessage: "stop-gate: 2 unit test file(s) failing — advisory; run pnpm test" };
      r.write("src/lib/a.ts", "export const a = 3;\n");
      expect(JSON.parse(await gate(red))).toEqual(warning);
      r.write("src/lib/a.ts", "export const a = 4;\n");
      expect(await gate(green)).toBe("");
      expect(Object.keys(r.manifest())).toEqual(["lastGreen"]);
      const { lastGreen } = r.manifest();
      r.write("src/lib/a.ts", "export const a = 3;\n"); // the red tree again
      expect(JSON.parse(await gate(red))).toEqual(warning);
      expect([red.calls.length, green.calls.length]).toEqual([2, 1]);
      // A red run keeps the green entry, so a revert to that tree stays silent without a run (and related
      // mode keeps its baseline).
      expect(Object.keys(r.manifest())).toEqual(["lastGreen", "lastReported"]);
      expect(r.manifest().lastGreen).toEqual(lastGreen);
      r.write("src/lib/a.ts", "export const a = 4;\n");
      expect(await gate(green)).toBe("");
      expect([red.calls.length, green.calls.length]).toEqual([2, 1]);
    } finally {
      r.cleanup();
    }
  });

  it("a run that fails without a test summary still warns once, with its exit code", async () => {
    const r = tempRepo();
    try {
      const s = stub(CRASH);
      expect(JSON.parse(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner }))).toEqual({
        systemMessage: "stop-gate: the unit test run failed (exit 2) — advisory; run pnpm test",
      });
    } finally {
      r.cleanup();
    }
  });

  it("a runner that never exits gives 'timed out … no result': SIGTERM, a grace period, SIGKILL to its whole process group, and the files it left are reported", async () => {
    const r = tempRepo();
    try {
      r.write("src/lib/draft.ts", "export const d = 1;\n"); // untracked before the run, so not counted
      const s = stub(HANG);
      const out = await run({ input: stopInput(r.d), env: {}, spawner: s.spawner, timeoutMs: 2000, graceMs: 300 });
      expect(JSON.parse(out)).toEqual({
        systemMessage: "stop-gate: timed out after 2s — no result; 1 untracked file(s) appeared during the killed run — check git status",
      });
      expect(() => process.kill(s.children[0].pid, 0)).toThrow(); // it ignored SIGTERM, so the SIGKILL ended it
      // The grandchild holds the stub's stdout and stderr, so they reach end-of-file only once the
      // grandchild is dead too (a zombie has closed them as well), and that came before the gate let go of
      // them. A kill that reaches only the direct child leaves it running for the rest of its 20 s, holding
      // them: the gate stops waiting one grace period after the SIGKILL, destroys them, and they never end.
      expect(s.eof).toEqual([true]);
      expect(r.manifest()).toEqual({ lastReported: { tree: expect.stringMatching(/^[0-9a-f]{16}$/), outcome: "timeout" } });
      expect(r.log()).toMatch(/"outcome":"timeout"/);
      expect(r.log()).not.toMatch(/left-behind/); // counts only
    } finally {
      r.cleanup();
    }
  });

  // 'close' waits for every process that holds the pipes, and a stray outside the run's process group can
  // hold them for as long as it lives. The hook process cannot exit while it holds open pipes, and Claude
  // Code discards the output of a hook that reaches its timeout, so the gate lets go of them when it stops
  // waiting.
  it("a run that exits in time while a stray outside its process group holds the pipes keeps its exit code, even when the deadline passes while the gate waits for them, and the gate lets go of the pipes", async () => {
    const r = tempRepo();
    const tmp = mkdtempSync(join(tmpdir(), "stop-gate-pid-"));
    const pidFile = join(tmp, "stray.pid");
    try {
      r.write("src/lib/a.ts", "export const a = 2;\n");
      const s = stub(`${leak(pidFile, true)} ${GREEN}`);
      // The stub exits long before the deadline, which then falls inside the two grace periods the gate
      // waits for the pipes after an exit.
      const timeoutMs = 800;
      const graceMs = 600;
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner, timeoutMs, graceMs })).toBe("");
      expect(Date.now() - s.started[0]).toBeLessThan(timeoutMs + 2 * graceMs + 1000);
      expect(Object.keys(r.manifest())).toEqual(["lastGreen"]);
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow(); // the stray outlived the wait
      expect(s.eof).toEqual([false]); // so the pipes never ended, and no 'close' came
      expect([s.children[0].stdout.destroyed, s.children[0].stderr.destroyed]).toEqual([true, true]);
    } finally {
      killFrom(pidFile);
      r.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it("a run that exits while a stray in its own process group still holds the pipes keeps its exit code, and the gate kills what is left of the group", async () => {
    const r = tempRepo();
    const tmp = mkdtempSync(join(tmpdir(), "stop-gate-pid-"));
    const pidFile = join(tmp, "stray.pid");
    try {
      r.write("src/lib/a.ts", "export const a = 2;\n");
      const s = stub(`${leak(pidFile, false)} ${GREEN}`);
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner, timeoutMs: 5000, graceMs: 200 })).toBe("");
      expect(Object.keys(r.manifest())).toEqual(["lastGreen"]);
      // The stray ignores SIGTERM and would hold the pipes for 5 s: they ended because a SIGKILL to the
      // group reached it, before the gate stopped waiting and destroyed them.
      expect(s.eof).toEqual([true]);
    } finally {
      killFrom(pidFile);
      r.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it("a killed run whose stray outside its process group still holds the pipes reports 'timed out … no result' by the deadline plus two grace periods, and the gate lets go of the pipes", async () => {
    const r = tempRepo();
    const tmp = mkdtempSync(join(tmpdir(), "stop-gate-pid-"));
    const pidFile = join(tmp, "stray.pid");
    try {
      r.write("src/lib/a.ts", "export const a = 2;\n");
      const s = stub(`${leak(pidFile, true)} ${STUBBORN}`);
      const timeoutMs = 1000;
      const graceMs = 150;
      const out = await run({ input: stopInput(r.d), env: {}, spawner: s.spawner, timeoutMs, graceMs });
      expect(Date.now() - s.started[0]).toBeLessThan(timeoutMs + 2 * graceMs + 1000);
      expect(JSON.parse(out)).toEqual({ systemMessage: "stop-gate: timed out after 1s — no result" });
      expect(() => process.kill(s.children[0].pid, 0)).toThrow(); // the group SIGKILL ended the stub
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow(); // but not the stray
      expect(s.eof).toEqual([false]);
      expect([s.children[0].stdout.destroyed, s.children[0].stderr.destroyed]).toEqual([true, true]);
    } finally {
      killFrom(pidFile);
      r.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  // The last bound: should the kill not reach the child at all (it left the process group), the gate stops
  // waiting one grace period after the SIGKILL and stops counting the child among what keeps it alive.
  it("a child out of reach of the group kill is given up on one grace period after the SIGKILL: 'timed out … no result', nothing of it keeps the process alive, and its later exit sends no signal", async () => {
    const r = tempRepo();
    // Started outside a process group of its own, so the gate's signals to the group never reach it.
    const s = stub(`setTimeout(() => {}, 5000)`, (argv, opts) => spawn(argv[0], argv.slice(1), { ...opts, stdio: ["ignore", "pipe", "pipe"] }));
    const children = () => process.getActiveResourcesInfo().filter((t) => t === "ProcessWrap").length;
    let kill;
    try {
      r.write("src/lib/a.ts", "export const a = 2;\n");
      const timeoutMs = 500;
      const graceMs = 100;
      const before = children();
      const out = await run({ input: stopInput(r.d), env: {}, spawner: s.spawner, timeoutMs, graceMs });
      expect(Date.now() - s.started[0]).toBeLessThan(timeoutMs + 2 * graceMs + 1000);
      expect(JSON.parse(out)).toEqual({ systemMessage: "stop-gate: timed out after 0.5s — no result" });
      const child = s.children[0];
      expect(() => process.kill(child.pid, 0)).not.toThrow(); // still running: no signal reached it
      expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true]);
      expect(children()).toBeLessThanOrEqual(before); // the live child no longer holds the event loop open
      // The run is over, so the child's exit no longer sets off the kill that follows an exit: by then the
      // group id may name another process's group.
      kill = vi.spyOn(process, "kill");
      const exited = new Promise((done) => child.once("exit", done));
      process.kill(child.pid, "SIGKILL");
      await exited;
      await new Promise((done) => setTimeout(done, 3 * graceMs));
      expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
    } finally {
      kill?.mockRestore();
      try {
        process.kill(s.children[0].pid, "SIGKILL");
      } catch {
        // already gone
      }
      r.cleanup();
    }
  }, 15_000);

  it("in a linked worktree, the manifest path lies under the common git dir's worktrees/<name>/", async () => {
    const r = tempRepo();
    const wt = `${r.d}-wt`;
    try {
      expect(r.git("worktree", "add", "-q", wt).status).toBe(0);
      const s = stub(GREEN);
      expect(await run({ input: stopInput(wt), env: {}, spawner: s.spawner })).toBe("");
      expect(s.cwds).toEqual([wt]);
      const common = r.git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
      expect(existsSync(join(common, "worktrees", basename(wt), "stop-gate.json"))).toBe(true);
      expect(existsSync(join(common, "stop-gate.json"))).toBe(false);
    } finally {
      r.cleanup();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("skips without running while another live gate holds the lock, and reclaims a dead holder's lock", async () => {
    const r = tempRepo();
    try {
      const lock = r.gitPath("stop-gate.lock");
      const s = stub(GREEN);
      writeFileSync(lock, JSON.stringify({ session_id: "s2", pid: process.pid }));
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner })).toBe("");
      expect(s.calls).toEqual([]);
      expect(existsSync(lock)).toBe(true); // not ours to remove
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      writeFileSync(lock, JSON.stringify({ session_id: "s2", pid: dead }));
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner })).toBe("");
      expect(s.calls.length).toBe(1);
      expect(existsSync(lock)).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("reclaims a lock older than any run even when its pid is alive, because pids are reused", async () => {
    const r = tempRepo();
    try {
      const lock = r.gitPath("stop-gate.lock");
      writeFileSync(lock, JSON.stringify({ session_id: "s2", pid: process.pid }));
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(lock, hourAgo, hourAgo);
      const s = stub(GREEN);
      expect(await run({ input: stopInput(r.d), env: {}, spawner: s.spawner })).toBe("");
      expect(s.calls.length).toBe(1);
      expect(existsSync(lock)).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("runs only inside CLAUDE_PROJECT_DIR's repository, resolved to the toplevel from any cwd in it", async () => {
    const r = tempRepo();
    const other = tempRepo();
    try {
      const s = stub(GREEN);
      expect(await run({ input: stopInput(r.d), env: { CLAUDE_PROJECT_DIR: other.d }, spawner: s.spawner })).toBe("");
      expect(s.calls).toEqual([]);
      expect(await run({ input: stopInput(join(r.d, "src")), env: { CLAUDE_PROJECT_DIR: r.d }, spawner: s.spawner })).toBe("");
      expect(s.cwds).toEqual([r.d]);
    } finally {
      r.cleanup();
      other.cleanup();
    }
  });

  it("related mode tests every path changed since the last green run (dirty now, dirty then, committed since) plus the global gates", async () => {
    const r = tempRepo();
    try {
      const s = stub(GREEN);
      const gate = () => run({ input: stopInput(r.d), env: { STOP_GATE_MODE: "related" }, spawner: s.spawner });
      r.write("src/lib/a.ts", "export const a = 2;\n"); // dirty at the first green run
      await gate();
      expect(s.calls).toEqual(FULL); // no green run to compare against yet
      r.write("src/lib/a.ts", "export const a = 1;\n"); // clean again, but not what last went green
      r.write("src/lib/b.ts", "export const b = 2;\n");
      r.git("commit", "-qam", "b"); // committed since
      r.write("src/lib/c.ts", "export const c = 1;\n"); // untracked now
      await gate();
      expect(s.calls.slice(1)).toEqual([
        ["pnpm", "exec", "vitest", "related", "src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "--run", "--maxWorkers=1"],
        ["pnpm", "exec", "vitest", "run", ...GLOBAL_GATES, "--maxWorkers=1"],
      ]);
      r.write("README.md", "# edited\n");
      await gate();
      expect(s.calls.slice(3)).toEqual(FULL);
    } finally {
      r.cleanup();
    }
  });

  // Related mode runs two commands. Either one failing makes the run red, the failing files add up, and a
  // red run keeps lastGreen, the baseline the next related run computes its changed set from.
  // [case, failing files, the `vitest related` stub, the global-gate stub]
  it.each([
    ["`vitest related` fails and the global gate passes", 2, RED, GREEN],
    ["the global gate fails and `vitest related` passes", 2, GREEN, RED],
    ["both fail", 4, RED, RED],
  ])("related mode, when %s, warns of %i failing file(s) and keeps lastGreen", async (_, failing, related, gates) => {
    const r = tempRepo();
    try {
      expect(await run({ input: stopInput(r.d), env: {}, spawner: stub(GREEN).spawner })).toBe("");
      const { lastGreen } = r.manifest();
      r.write("src/lib/a.ts", "export const a = 2;\n");
      const s = stub((argv) => (argv.includes("related") ? related : gates));
      const out = await run({ input: stopInput(r.d), env: { STOP_GATE_MODE: "related" }, spawner: s.spawner });
      expect(s.calls).toEqual([
        ["pnpm", "exec", "vitest", "related", "src/lib/a.ts", "--run", "--maxWorkers=1"],
        ["pnpm", "exec", "vitest", "run", ...GLOBAL_GATES, "--maxWorkers=1"],
      ]);
      expect(JSON.parse(out)).toEqual({ systemMessage: `stop-gate: ${failing} unit test file(s) failing — advisory; run pnpm test` });
      expect(r.manifest()).toEqual({ lastGreen, lastReported: { tree: expect.stringMatching(/^[0-9a-f]{16}$/), outcome: "red" } });
      expect(r.log()).toMatch(new RegExp(`"outcome":"red","code":1,"failed":${failing}\\}`));
    } finally {
      r.cleanup();
    }
  });

  it("related mode runs its commands under one deadline: a slow first command leaves the second only the time left, and a timeout keeps lastGreen", async () => {
    const r = tempRepo();
    try {
      expect(await run({ input: stopInput(r.d), env: {}, spawner: stub(GREEN).spawner })).toBe("");
      const { lastGreen } = r.manifest();
      r.write("src/lib/a.ts", "export const a = 2;\n");
      // `vitest related` passes after 1 s; the global gate then hangs until the SIGKILL.
      const s = stub((argv) => (argv.includes("related") ? `setTimeout(() => console.log(" Test Files  1 passed (1)"), 1000)` : STUBBORN));
      const timeoutMs = 2000;
      const graceMs = 100;
      const out = await run({ input: stopInput(r.d), env: { STOP_GATE_MODE: "related" }, spawner: s.spawner, timeoutMs, graceMs });
      expect(s.calls.map((argv) => argv[3])).toEqual(["related", "run"]);
      expect(JSON.parse(out)).toEqual({ systemMessage: "stop-gate: timed out after 2s — no result" });
      // The whole run ends by the one deadline plus the kill's grace periods. A full timeoutMs for the
      // second command would end it no sooner than 1 s + timeoutMs + graceMs after the first started.
      expect(Date.now() - s.started[0]).toBeLessThan(timeoutMs + 2 * graceMs + 500);
      expect(r.manifest()).toEqual({ lastGreen, lastReported: { tree: expect.stringMatching(/^[0-9a-f]{16}$/), outcome: "timeout" } });
    } finally {
      r.cleanup();
    }
  }, 15_000);

  it("as a process it reads the Stop JSON from stdin and exits 0 silently when disabled, fed input that is not a Stop event (not JSON, not an object, another hook event), or outside a git checkout", () => {
    const r = tempRepo();
    const plain = mkdtempSync(join(tmpdir(), "stop-gate-nogit-"));
    const hook = (stdin, extra, cwd) =>
      spawnSync(process.execPath, [HOOK], { cwd, input: stdin, encoding: "utf8", env: { ...process.env, STOP_GATE: "", STOP_GATE_MODE: "", CLAUDE_PROJECT_DIR: "", ...extra } });
    try {
      expect(spawnSync("git", ["-C", plain, "rev-parse", "--show-toplevel"]).status).not.toBe(0);
      // [stdin, env, the process cwd]. The gate is enabled in all but the first, and the repo has no
      // node_modules, so a gate that ran there would print a failure instead of staying silent.
      const cases = [
        [JSON.stringify(stopInput(r.d)), { STOP_GATE: "0" }, r.d],
        ["not json", {}, r.d],
        ["null", {}, r.d],
        ["[]", {}, r.d],
        [JSON.stringify(stopInput(r.d, { hook_event_name: "SubagentStop" })), {}, r.d],
        [JSON.stringify(stopInput(plain)), {}, plain],
      ];
      for (const [stdin, extra, cwd] of cases) {
        const p = hook(stdin, extra, cwd);
        expect({ stdin, status: p.status, stdout: p.stdout }).toEqual({ stdin, status: 0, stdout: "" });
      }
      // The control, last because it records this tree as reported: a Stop input runs the gate there, and
      // its one advisory line shows the silences above are not vacuous.
      const p = hook(JSON.stringify(stopInput(r.d)), {}, r.d);
      expect(p.status).toBe(0);
      expect(p.stdout).toMatch(/^\{"systemMessage":"stop-gate: [^"\n]+ — advisory; run pnpm test"\}\n$/);
    } finally {
      r.cleanup();
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
