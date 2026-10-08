// `pnpm trace bench-judge` — verify the manifest's `judge.catches` claims by actually
// running each fixture's deterministic judge: apply the patch to the working tree, run
// the judge command, then reverse the patch. Refuses to touch files with local changes.
// The ground truth about "what our tests catch" is then an observed fact, not a guess.
//
// Safety (from two checker rounds on this tool):
// - every judge command first runs on the CLEAN tree — a judge that already fails there
//   cannot "catch" anything, so the run aborts instead of reporting false catches;
// - a judge that could not run (spawn error, timeout, signal) is "not observed", never
//   "caught";
// - judges run ASYNCHRONOUSLY, so SIGINT/SIGTERM/SIGHUP are actually delivered: the
//   handler kills the running judge, the current patch is reversed, and the run stops
//   (a synchronous spawn loop would swallow the signal — the first fix did exactly that);
// - anything that still kills the process mid-fixture (SIGKILL, a crash) leaves a patch
//   applied, so every run starts by detecting applied fixture patches and refuses to
//   continue until `pnpm trace bench-judge --recover` reverses them;
// - judges run with an allowlisted environment, so a seeded secret-leak fixture served
//   by the dev server has no real secrets to leak.
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowBlock, opaqueFixtureId, ROOT, staleFixtures } from "./lib.mjs";

// Only what node/pnpm/playwright need. No tokens, keys or proxy credentials.
const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
  "NODE_OPTIONS", "PNPM_HOME", "COREPACK_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
];
export const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function judgeEnv(source = process.env) {
  const env = { CI: "true", NEXT_TELEMETRY_DISABLED: "1" };
  for (const k of ENV_ALLOW) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/** Default async spawner: resolves { status, signal, error } and exposes the child for kill(). */
function spawnJudge(cmd, args, opts, onChild) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAsync(cmd, args, { ...opts, stdio: "ignore", detached: true });
    } catch (error) {
      resolve({ error, status: null });
      return;
    }
    onChild(child);
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeout || 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, status: null });
    });
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
}

/**
 * Run a judge command; resolves true (failed = caught), false (passed) or null (did not
 * run). `spawn` may return a result or a promise of one (tests inject a stub).
 */
export async function runJudge(command, { spawn, env = judgeEnv(), onChild = () => {}, timeoutMs = 600_000 } = {}) {
  const [cmd, ...cmdArgs] = command.split(/\s+/);
  const run = await (spawn ? spawn(cmd, cmdArgs, { cwd: ROOT, env }) : spawnJudge(cmd, cmdArgs, { cwd: ROOT, env, timeout: timeoutMs }, onChild));
  if (run.error || run.signal || run.status === null) return null;
  return run.status !== 0;
}

/** Fixture patches that are currently applied to the working tree (an interrupted run). */
export function appliedFixtures(manifest, { reverseApplies } = {}) {
  const check =
    reverseApplies ||
    ((patch) => git(["apply", "-R", "--check", "-"], { input: patch, stdio: ["pipe", "pipe", "pipe"] }).status === 0);
  return manifest.fixtures.filter((f) => check(f.patch));
}

/** Reverse every applied fixture patch (recovery after a SIGKILL/crash mid-run). */
export function recoverApplied(manifest, { applied = appliedFixtures } = {}) {
  const reversed = [];
  for (const f of applied(manifest)) {
    const r = git(["apply", "-R", "-"], { input: f.patch, stdio: ["pipe", "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`could not reverse ${f.id}: ${String(r.stderr).trim()}`);
    reversed.push(f.id);
  }
  return reversed;
}

/**
 * The CLI precondition for bench-args / bench-judge. Order matters: a fixture patch left
 * applied by a killed run ALSO fails the stale check (its forward apply no longer
 * applies), so applied patches are detected — and with `recover`, reversed — before any
 * fixture is reported stale. Returns { reversed } | { error, … } | {}.
 */
export function benchPreflight(manifest, { recover = false, applied = appliedFixtures, applies } = {}) {
  if (recover) return { reversed: recoverApplied(manifest, { applied }) };
  const left = applied(manifest);
  if (left.length) {
    return { error: `${left.length} fixture patch(es) are still applied to the working tree (an interrupted bench-judge run?) — run \`pnpm trace bench-judge --recover\` first`, applied: left.map((f) => opaqueFixtureId(f.id)) };
  }
  const check = applies || ((patch) => git(["apply", "--check", "-"], { input: patch, stdio: ["pipe", "pipe", "pipe"] }).status === 0);
  const stale = staleFixtures(manifest, check);
  if (stale.length) return { error: "stale fixtures — their patches no longer apply to the working tree; regenerate them (bench-unpack → edit → bench-pack)", stale };
  return {};
}

export async function runBenchJudge(
  manifest,
  { only, skipE2e, log = (s) => process.stderr.write(`${s}\n`), judge, applied = appliedFixtures, signals = SIGNALS } = {},
) {
  const { hitsDenylist, parseDiffPaths } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist", "parseDiffPaths"]);
  const leftovers = applied(manifest);
  if (leftovers.length) {
    throw new Error(`${leftovers.length} fixture patch(es) are currently applied to the working tree (an interrupted run?) — run \`pnpm trace bench-judge --recover\` first`);
  }
  const selected = manifest.fixtures.filter((f) => !only || only.includes(f.id));
  const isE2e = (c) => /test:e2e/.test(c || "");
  const commandJudged = selected.filter((f) => f.judge?.kind === "command" && !(skipE2e && isE2e(f.judge.command)));

  let interrupted = false;
  let current = null; // the running judge child, killed on a signal
  const onSignal = (sig) => {
    interrupted = true;
    log(`bench-judge: ${sig} — stopping after the current fixture is restored`);
    if (current && current.pid) {
      try {
        process.kill(-current.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  for (const s of signals) process.on(s, onSignal);
  const runOne = (command) => (judge ? judge(command) : runJudge(command, { onChild: (c) => (current = c) }));

  const results = [];
  const scratch = mkdtempSync(join(tmpdir(), "trace-bench-judge-"));
  const touchable = [...new Set(manifest.fixtures.flatMap((f) => parseDiffPaths(f.patch)))];
  const status = () => git(["status", "--porcelain", "--", ...touchable]).stdout;
  const before = status();
  try {
    // Baseline: each distinct judge command must pass on the unpatched tree.
    for (const command of [...new Set(commandJudged.map((f) => f.judge.command))]) {
      if (interrupted) break;
      log(`bench-judge: baseline (clean tree) → ${command}`);
      const failedClean = await runOne(command);
      current = null;
      if (interrupted) break;
      if (failedClean !== false) {
        throw new Error(`baseline failed: \`${command}\` ${failedClean === null ? "did not run" : "already fails on the clean tree"} — fix that before judging fixtures`);
      }
    }
    for (const f of selected) {
      if (interrupted) break;
      const patchPath = join(scratch, `${f.id}.patch`);
      writeFileSync(patchPath, f.patch);
      const paths = [...new Set(parseDiffPaths(f.patch))];
      const j = f.judge || {};
      if (j.kind === "none") {
        results.push({ id: f.id, kind: j.kind, expected: false, observed: false, ok: true, note: "no deterministic judge covers this defect" });
        continue;
      }
      if (j.kind === "denylist") {
        const observed = hitsDenylist(paths);
        results.push({ id: f.id, kind: j.kind, expected: j.catches, observed, ok: observed === j.catches, note: paths.join(", ") });
        continue;
      }
      if (skipE2e && isE2e(j.command)) {
        results.push({ id: f.id, kind: j.kind, expected: j.catches, observed: null, ok: null, note: "skipped (--skip-e2e)" });
        continue;
      }
      // Safety: the patched files must be clean so the reverse-apply restores them exactly.
      const dirty = git(["status", "--porcelain", "--", ...paths]).stdout.trim();
      if (dirty) {
        results.push({ id: f.id, kind: j.kind, expected: j.catches, observed: null, ok: false, note: `refused: local changes in ${paths.join(", ")}` });
        continue;
      }
      const appliedNow = git(["apply", patchPath]);
      if (appliedNow.status !== 0) {
        results.push({ id: f.id, kind: j.kind, expected: j.catches, observed: null, ok: false, note: `patch does not apply: ${appliedNow.stderr.trim()}` });
        continue;
      }
      let observed = null;
      try {
        log(`bench-judge: ${f.id} → ${j.command}`);
        observed = await runOne(j.command);
      } finally {
        current = null;
        const reverted = git(["apply", "-R", patchPath]);
        if (reverted.status !== 0) {
          throw new Error(`could not reverse ${f.id} — run \`pnpm trace bench-judge --recover\` (or restore ${paths.join(", ")} with git checkout)`);
        }
      }
      if (interrupted) break; // the judge was killed by our own handler — not a measurement
      results.push({
        id: f.id, kind: j.kind, expected: j.catches, observed,
        ok: observed === null ? false : observed === j.catches,
        note: observed === null ? `judge did not run: ${j.command}` : j.command,
      });
    }
  } finally {
    for (const s of signals) process.off(s, onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }
  // Belt and braces: the working tree must be exactly as we found it.
  if (status() !== before) {
    throw new Error("working tree changed during bench-judge — inspect `git status` (or run `pnpm trace bench-judge --recover`) before continuing");
  }
  if (interrupted) throw new Error(`interrupted after ${results.length} fixture(s); the tree was restored`);
  return results;
}
