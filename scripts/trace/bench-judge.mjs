// `pnpm trace bench-judge` — verify the manifest's `judge.catches` claims by actually
// running each fixture's deterministic judge: apply the patch to the working tree, run
// the judge command, then reverse the patch. Refuses to touch files with local changes.
// The ground truth about "what our tests catch" is then an observed fact, not a guess.
//
// Safety (from the checker round on this tool):
// - every judge command first runs on the CLEAN tree — a judge that already fails there
//   cannot "catch" anything, so the run aborts instead of reporting false catches;
// - a judge that could not run (spawn error, timeout, signal) is "not observed", never
//   "caught";
// - SIGINT/SIGTERM stop after the current fixture's patch is reversed;
// - judges run with an allowlisted environment, so a seeded secret-leak fixture served
//   by the dev server has no real secrets to leak.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowBlock, ROOT } from "./lib.mjs";

// Only what node/pnpm/playwright need. No tokens, keys or proxy credentials.
const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
  "NODE_OPTIONS", "PNPM_HOME", "COREPACK_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
];

export function judgeEnv(source = process.env) {
  const env = { CI: "true", NEXT_TELEMETRY_DISABLED: "1" };
  for (const k of ENV_ALLOW) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/** Run a judge command; returns true (failed = caught), false (passed) or null (did not run). */
export function runJudge(command, { spawn = spawnSync, env = judgeEnv() } = {}) {
  const [cmd, ...cmdArgs] = command.split(/\s+/);
  const run = spawn(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", env, timeout: 600_000 });
  if (run.error || run.signal || run.status === null) return null;
  return run.status !== 0;
}

export function runBenchJudge(manifest, { only, skipE2e, log = (s) => process.stderr.write(`${s}\n`), judge = runJudge } = {}) {
  const { hitsDenylist, parseDiffPaths } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist", "parseDiffPaths"]);
  const selected = manifest.fixtures.filter((f) => !only || only.includes(f.id));
  const isE2e = (c) => /test:e2e/.test(c || "");
  const commandJudged = selected.filter((f) => f.judge?.kind === "command" && !(skipE2e && isE2e(f.judge.command)));

  // Baseline: each distinct judge command must pass on the unpatched tree.
  for (const command of [...new Set(commandJudged.map((f) => f.judge.command))]) {
    log(`bench-judge: baseline (clean tree) → ${command}`);
    const failedClean = judge(command);
    if (failedClean !== false) {
      throw new Error(`baseline failed: \`${command}\` ${failedClean === null ? "did not run" : "already fails on the clean tree"} — fix that before judging fixtures`);
    }
  }

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results = [];
  const scratch = mkdtempSync(join(tmpdir(), "trace-bench-judge-"));
  const touchable = [...new Set(manifest.fixtures.flatMap((f) => parseDiffPaths(f.patch)))];
  const status = () => git(["status", "--porcelain", "--", ...touchable]).stdout;
  const before = status();
  try {
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
      const applied = git(["apply", patchPath]);
      if (applied.status !== 0) {
        results.push({ id: f.id, kind: j.kind, expected: j.catches, observed: null, ok: false, note: `patch does not apply: ${applied.stderr.trim()}` });
        continue;
      }
      let observed = null;
      try {
        log(`bench-judge: ${f.id} → ${j.command}`);
        observed = judge(j.command);
      } finally {
        const reverted = git(["apply", "-R", patchPath]);
        if (reverted.status !== 0) {
          throw new Error(`could not reverse ${f.id} — restore ${paths.join(", ")} with git checkout before continuing`);
        }
      }
      results.push({
        id: f.id, kind: j.kind, expected: j.catches, observed,
        ok: observed === null ? false : observed === j.catches,
        note: observed === null ? `judge did not run: ${j.command}` : j.command,
      });
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }
  // Belt and braces: the working tree must be exactly as we found it.
  if (status() !== before) {
    throw new Error("working tree changed during bench-judge — inspect `git status` before continuing");
  }
  if (interrupted) throw new Error(`interrupted after ${results.length} fixture(s); the tree was restored`);
  return results;
}
