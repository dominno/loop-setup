// `pnpm trace bench-judge` — verify the manifest's `judge.catches` claims by actually
// running each fixture's deterministic judge: apply the patch to the working tree, run
// the judge command, then reverse the patch. Refuses to touch files with local changes.
// The ground truth about "what our tests catch" is then an observed fact, not a guess.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowBlock, ROOT } from "./lib.mjs";

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

export function runBenchJudge(manifest, { only, skipE2e, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const { hitsDenylist, parseDiffPaths } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist", "parseDiffPaths"]);
  const results = [];
  // Patches live inline in the encoded bundle; materialize each one outside the repo.
  const scratch = mkdtempSync(join(tmpdir(), "trace-bench-judge-"));
  // Scope the before/after integrity check to the files fixtures can touch, so
  // unrelated concurrent edits elsewhere in the tree do not trip it.
  const touchable = [...new Set(manifest.fixtures.flatMap((f) => parseDiffPaths(f.patch)))];
  const status = () => git(["status", "--porcelain", "--", ...touchable]).stdout;
  const before = status();
  for (const f of manifest.fixtures) {
    if (only && !only.includes(f.id)) continue;
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
    if (skipE2e && /test:e2e/.test(j.command)) {
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
      const [cmd, ...cmdArgs] = j.command.split(/\s+/);
      const run = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "true" }, timeout: 600_000 });
      observed = run.status !== 0;
    } finally {
      const reverted = git(["apply", "-R", patchPath]);
      if (reverted.status !== 0) {
        throw new Error(`could not reverse ${f.id} — restore ${paths.join(", ")} with git checkout before continuing`);
      }
    }
    results.push({ id: f.id, kind: j.kind, expected: j.catches, observed, ok: observed === j.catches, note: j.command });
  }
  rmSync(scratch, { recursive: true, force: true });
  // Belt and braces: the working tree must be exactly as we found it.
  if (status() !== before) {
    throw new Error("working tree changed during bench-judge — inspect `git status` before continuing");
  }
  return results;
}
