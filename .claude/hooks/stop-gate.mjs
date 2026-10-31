#!/usr/bin/env node
// stop-gate: an OPT-IN, advisory Stop hook. At the end of a turn it runs the unit tests once per
// working-tree state and, when they fail, shows the user one line. No committed settings file enables
// it; docs/adoption-guide.md ("Optional hooks") has the snippet for your own settings.local.json.
//
// It never blocks or continues the turn and always exits 0. It never runs a build, E2E or a dev
// server. It never writes TRACE records, wiki facts or loop-plan state: its manifest, lock and log
// live under `git rev-parse --git-path`, per worktree. Its output is never evidence for a CLEAR (the
// Lead's own check run is), and it carries counts only, never test names.
// Node ESM with no dependencies beyond the trace library's tree fingerprint; the exported functions
// are tested in scripts/hooks/stop-gate.test.mjs.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { treeFingerprint } from "../../scripts/trace/lib.mjs";

/**
 * Tests that read the tree by path, which `vitest related` never selects (it follows imports only), so
 * every related-mode run includes them. contracts.test.mjs reads the workflows, the policy page and the
 * record store, and scans every tracked file for bench ground truth. Add your own path-reading tests.
 */
export const GLOBAL_GATES = ["scripts/trace/contracts.test.mjs"];
// The Stop input's background_tasks labels for work this session is waiting on: a run now would compete
// with it (a bench fan-out runs the repo's checks in every verifier).
const BUSY_TYPES = ["workflow", "subagent", "teammate", "cloud session"];
// Any other background task that mentions these may be loading the machine with tests or rewriting the
// tree (bench-judge applies fixture patches). A background `pnpm dev` mentions none of them.
const BUSY_WORDS = /vitest|playwright|test|verify|bench|trace/i;
// The worst case is TIMEOUT_MS, a grace period before the SIGKILL and one after it, plus a few git calls.
// It has to end inside the 120 s hook timeout the documented snippet sets, which is also the most
// scripts/trace/config.test.mjs allows a committed hook, so the gate reports its own timeout first.
export const TIMEOUT_MS = 90_000;
export const GRACE_MS = 5_000;
// Past this age a lock is stale whatever its pid says (pids are reused); a run holds it for at most the
// fingerprint, the timeout and two grace periods.
const STALE_LOCK_MS = 10 * 60_000;
const OUTPUT_CAP = 64 * 1024;
const VITEST = ["pnpm", "exec", "vitest"];

const skip = (reason) => ({ run: false, reason });

/**
 * Whether this turn end runs the gate: {run: true} or {run: false, reason}. Pure. `holder` is the record
 * of a live gate (another session's, in practice) that holds this worktree's lock, or null.
 */
export function decide(input, env = {}, holder = null) {
  if (env.STOP_GATE === "0") return skip("disabled (STOP_GATE=0)");
  // Registered under another event, the gate does nothing: SubagentStop fires after every foreground
  // subagent, a tool event on every call.
  if (input?.hook_event_name !== undefined && input.hook_event_name !== "Stop") return skip(`not a Stop event (${input.hook_event_name})`);
  if (input?.stop_hook_active) return skip("a Stop hook is already continuing this turn");
  if (holder) return skip(`another gate holds the lock (session ${holder.session_id ?? "unknown"})`);
  for (const task of Array.isArray(input?.background_tasks) ? input.background_tasks : []) {
    // Keyed on presence, never on status: the status values are undocumented.
    if (BUSY_TYPES.includes(task?.type)) return skip(`a background ${task.type} is in flight`);
    if (BUSY_WORDS.test(JSON.stringify(task))) return skip("a background task may be running tests or rewriting the tree");
  }
  return { run: true };
}

/**
 * The vitest commands one gate run executes. The default is the full unit suite. STOP_GATE_MODE=related
 * runs `vitest related` on the changed paths plus GLOBAL_GATES, and only when every changed path is a
 * src/ file that still exists: any other path may be read by a test (cli.test.mjs reads README.md, the
 * leak guard reads every tracked file), `vitest related` selects nothing for a deleted file, and an
 * unknown changed set (not an array) proves nothing. Pure: `exists` says whether a repo path is on disk.
 */
export function planRun({ mode, changed, exists = () => true } = {}) {
  const related = mode === "related" && Array.isArray(changed) && changed.every((p) => p.startsWith("src/") && exists(p));
  if (!related) return { mode: "full", commands: [[...VITEST, "run", "--maxWorkers=2"]] };
  const gates = GLOBAL_GATES.filter((p) => exists(p));
  return {
    mode: "related",
    commands: [
      ...(changed.length ? [[...VITEST, "related", ...changed, "--run", "--maxWorkers=1"]] : []),
      ...(gates.length ? [[...VITEST, "run", ...gates, "--maxWorkers=1"]] : []),
    ],
  };
}

/** Starts one planned command in its own process group, so a kill reaches pnpm, vitest and its workers. */
export function spawnCommand(argv, { cwd, env }) {
  return spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * One gate run for a Stop hook input. Returns what the hook prints: "" (silent) or one JSON line whose
 * systemMessage the user sees (the model does not). `spawner` starts each planned command; tests inject
 * a stub.
 */
export async function run({ input = {}, env = process.env, spawner = spawnCommand, timeoutMs = TIMEOUT_MS, graceMs = GRACE_MS } = {}) {
  if (!decide(input, env).run) return "";
  const repo = locate(typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd(), env);
  if (!repo) return "";
  const holder = takeLock(repo.lock, input?.session_id);
  try {
    if (!decide(input, env, holder).run) return "";
    return await gate(repo, env, { spawner, timeoutMs, graceMs });
  } finally {
    if (!holder) releaseLock(repo.lock);
  }
}

async function gate(repo, env, { spawner, timeoutMs, graceMs }) {
  const now = snapshot(repo.top);
  if (!now) return "";
  const manifest = readManifest(repo.manifest);
  if (now.tree === manifest.lastGreen?.tree || now.tree === manifest.lastReported?.tree) return "";
  const plan = planRun({
    mode: env.STOP_GATE_MODE,
    changed: env.STOP_GATE_MODE === "related" ? changedSince(repo.top, manifest.lastGreen, now) : null,
    exists: (p) => existsSync(join(repo.top, p)),
  });
  const started = Date.now();
  const result = await execute(plan.commands, { cwd: repo.top, spawner, timeoutMs, graceMs });
  const entry = { at: new Date().toISOString(), tree: now.tree, mode: plan.mode, ms: Date.now() - started };
  if (result.timedOut) {
    // cli.test.mjs writes into the tree and cleans up only in finally blocks, which a SIGKILL skips.
    const before = new Set(now.untracked);
    const appeared = nul(git(repo.top, ["ls-files", "--others", "--exclude-standard", "-z"])).filter((p) => !before.has(p)).length;
    writeManifest(repo.manifest, { ...manifest, lastReported: { tree: now.tree, outcome: "timeout" } });
    appendLog(repo.log, { ...entry, outcome: "timeout", appeared });
    const leftovers = appeared ? `; ${appeared} untracked file(s) appeared during the killed run — check git status` : "";
    return message(`timed out after ${timeoutMs / 1000}s — no result${leftovers}`);
  }
  if (result.code === 0) {
    writeManifest(repo.manifest, { lastGreen: { head: now.head, tree: now.tree, dirty: now.dirty } });
    appendLog(repo.log, { ...entry, outcome: "green", code: 0, failed: 0 });
    return "";
  }
  writeManifest(repo.manifest, { ...manifest, lastReported: { tree: now.tree, outcome: "red" } });
  appendLog(repo.log, { ...entry, outcome: "red", code: result.code, failed: result.failed });
  return message(
    result.failed > 0
      ? `${result.failed} unit test file(s) failing — advisory; run pnpm test`
      : `the unit test run failed (exit ${result.code}) — advisory; run pnpm test`,
  );
}

const message = (text) => JSON.stringify({ systemMessage: `stop-gate: ${text}` }) + "\n";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}
const nul = (text) => (text ?? "").split("\0").filter(Boolean);
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The worktree that holds the session's cwd (stdin's cwd, so a linked worktree gets its own state;
 * CLAUDE_PROJECT_DIR names the main checkout) and its state paths. Null outside a git checkout, and
 * outside CLAUDE_PROJECT_DIR's repository: a session can sit in an added directory of another
 * repository, whose suite this gate has no business running.
 */
function locate(cwd, env) {
  const paths = (dir) => git(dir, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--git-path", "stop-gate.json", "--git-path", "stop-gate.lock", "--git-path", "stop-gate.log"])?.split("\n");
  const here = paths(cwd);
  if (!here) return null;
  const [top, common, manifest, lock, log] = here;
  if (env.CLAUDE_PROJECT_DIR) {
    const project = paths(env.CLAUDE_PROJECT_DIR);
    if (!project || real(project[1]) !== real(common)) return null;
  }
  return { top, manifest, lock, log };
}

/**
 * HEAD, the tree fingerprint and the dirty paths; null without a HEAD. Unlike `pnpm trace tree-id`
 * nothing is excluded, because tests read the record store and the loop files too.
 */
function snapshot(top) {
  const head = git(top, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  if (!head) return null;
  const diff = git(top, ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--no-color"]);
  const tracked = git(top, ["diff", "HEAD", "--name-only", "--no-renames", "-z"]);
  const others = git(top, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || tracked === null || others === null) return null;
  const untracked = nul(others);
  // Unreadable entries (a nested checkout, a broken symlink) count by path only, as in tree-id.
  const contents = untracked.map((p) => {
    try {
      return { path: p, content: readFileSync(join(top, p)) };
    } catch {
      return { path: p, content: "<unreadable>" };
    }
  });
  const dirty = [...new Set([...nul(tracked), ...untracked])].sort();
  return { head, tree: treeFingerprint({ head, diff, untracked: contents }), dirty, untracked };
}

/** Every path that may differ from the last green run: dirty now, dirty then, or changed since its HEAD. */
function changedSince(top, green, now) {
  if (typeof green?.head !== "string" || !/^[0-9a-f]{40,64}$/.test(green.head)) return null;
  const since = git(top, ["diff", "--name-only", "--no-renames", "-z", green.head, "--"]);
  if (since === null) return null; // that commit is gone (rebased away and pruned)
  return [...new Set([...now.dirty, ...(Array.isArray(green.dirty) ? green.dirty : []), ...nul(since)])].sort();
}

/** Runs the plan's commands in order under one deadline: {timedOut, code, failed}. */
async function execute(commands, { cwd, spawner, timeoutMs, graceMs }) {
  const deadline = Date.now() + timeoutMs;
  const env = { ...process.env, NO_COLOR: "1" };
  let code = 0;
  let failed = 0;
  for (const argv of commands) {
    const left = deadline - Date.now();
    if (left <= 0) return { timedOut: true };
    const r = await settle(spawner(argv, { cwd, env }), left, graceMs);
    if (r.timedOut) return { timedOut: true };
    if (code === 0 && r.code !== 0) code = r.code;
    failed += failedFiles(r.output);
  }
  return { timedOut: false, code, failed };
}

/**
 * Waits for one child for at most `ms`, then sends its process group SIGTERM, waits `graceMs`, sends
 * SIGKILL, and stops waiting after one more `graceMs` (should the kill not reach the child). 'close' also
 * waits for every process that holds the pipes, so once the child has exited its exit code stands: what is
 * left of its group gets `graceMs` to let go of them, then SIGKILL, and the gate stops waiting `graceMs`
 * later (a stray outside the group can hold them for as long as it lives). Finishing lets go of the pipes
 * and the child, so nothing left behind keeps the hook process alive.
 * Resolves {code, timedOut, output}; code is the exit code, the signal name or the spawn error code.
 */
function settle(child, ms, graceMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let done = false;
    const timers = [];
    const after = (delay, fn) => {
      if (!done) timers.push(setTimeout(fn, delay));
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      out = (out + chunk).slice(-OUTPUT_CAP);
    });
    child.stderr?.on("data", (chunk) => {
      err = (err + chunk).slice(-OUTPUT_CAP);
    });
    const finish = (code) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ code, timedOut, output: `${out}\n${err}` });
    };
    child.on("error", (e) => finish(e.code ?? "spawn error"));
    child.on("close", (code, signal) => finish(code ?? signal));
    child.on("exit", (code, signal) => {
      if (!timedOut) timers.forEach(clearTimeout); // it ended in time: its exit code stands
      after(graceMs, () => {
        signalGroup(child, "SIGKILL");
        after(graceMs, () => finish(code ?? signal));
      });
    });
    after(ms, () => {
      timedOut = true;
      signalGroup(child, "SIGTERM");
      after(graceMs, () => {
        signalGroup(child, "SIGKILL");
        after(graceMs, () => finish("SIGKILL"));
      });
    });
  });
}

function signalGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** The failed test-file count from vitest's summary line ("Test Files  2 failed | 9 passed (11)"); 0 without one. */
const failedFiles = (output) => Number(/Test Files\s+(\d+) failed/.exec(output.replace(ANSI, ""))?.[1] ?? 0);

/**
 * Takes this worktree's lock: null when this run now holds it, else the live holder's record. A lock
 * whose holder died, or that has outlived any run, is reclaimed.
 */
function takeLock(path, sessionId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ session_id: sessionId ?? null, pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const holder = liveHolder(path);
    if (holder) return holder;
    try {
      unlinkSync(path);
    } catch {
      // another run reclaimed it first
    }
  }
  return {}; // lost the race twice: treat the lock as held
}

function liveHolder(path) {
  let record = {};
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) return null;
    record = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch (e) {
    if (e.code === "ENOENT") return null; // released meanwhile
    // A half-written record belongs to a lock taken a moment ago: held.
  }
  if (Number.isInteger(record.pid) && !alive(record.pid)) return null;
  return record;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function releaseLock(path) {
  try {
    if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path);
  } catch {
    // already gone
  }
}

function readManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return manifest && typeof manifest === "object" ? manifest : {};
  } catch {
    return {};
  }
}

function writeManifest(path, manifest) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, path); // a killed run never leaves half a manifest
}

function appendLog(path, entry) {
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // the log is a convenience; it never fails the gate
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return; // not a Stop hook input: nothing to decide on
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  try {
    process.stdout.write(await run({ input }));
  } catch (e) {
    process.stdout.write(message(`internal error — no result (${String(e?.message ?? e).split("\n")[0].slice(0, 200)})`));
  }
}

// Run as the hook; importing the module (the tests do) runs nothing. It always exits 0.
const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) await main().catch(() => {});
