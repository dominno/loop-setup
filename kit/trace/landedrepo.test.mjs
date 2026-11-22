// The landed port on the REAL stack (phase C, goal C5): a temp project repo, a workspace with a plan
// and a record store, the CLI run as a process. A done node's CLEAR records its patch-id; whether its
// dependent is ready depends on what HEAD's history holds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { appendActions } from "./lib.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
let T;
let P; // the project repo
let WS; // the workspace (LOOP_SETUP_WORKSPACE)
let HOME;
let base;
let patchFile;
let patchId;
let recordA;
let recordC;
let recordE;

const git = (...a) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: P, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const env = (extra = {}) => {
  const e = { ...process.env, LOOP_SETUP_WORKSPACE: WS, CLAUDE_CONFIG_DIR: HOME, ...extra };
  for (const k of ["TRACE_STORE", "CLAUDECODE"]) if (!(k in extra)) delete e[k];
  return e;
};
const cli = (args, input, extra) => spawnSync(process.execPath, [CLI, ...args], { cwd: P, encoding: "utf8", input, env: env(extra) });
const ok = (r) => expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
const ready = () => JSON.parse(cli(["plan-ready"]).stdout);
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const write = (lines) => writeFileSync(join(P, "src/a.txt"), `${lines.join("\n")}\n`);
const withLine = (lines, i, text) => lines.map((l, j) => (j === i ? text : l));
const resetMain = () => {
  git("checkout", "-q", "main");
  git("reset", "-q", "--hard", base);
  git("clean", "-qfd");
};
const verifierDraft = (node) =>
  JSON.stringify({ writer_id: `loop-iteration/verify:${node}-0`, claim_id: `loop:${node.toLowerCase()}`, claim_text: `${node} holds`, claim_type: "factual", evidence: [{ kind: "command", ref: "pnpm test", result: "pass" }], final_status: "accept", reason: "verified", provenance: { workflow: "loop-iteration" } });

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "ls-landed-")));
  P = join(T, "proj");
  WS = join(T, "ws");
  HOME = join(T, "home", ".claude");
  mkdirSync(join(P, "src"), { recursive: true });
  mkdirSync(join(WS, "trace"), { recursive: true });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(join(WS, "trace/records.jsonl"), "");
  git("init", "-q", "-b", "main");
  write(LINES);
  git("add", "-A");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  // The node's change (what the loop applied to the working tree), as a patch file and its patch-id.
  write(withLine(LINES, 4, "line 5 — fixed"));
  patchFile = join(T, "node.patch");
  writeFileSync(patchFile, git("diff") + "\n");
  patchId = spawnSync("git", ["patch-id", "--stable"], { cwd: P, input: readFileSync(patchFile), encoding: "utf8" }).stdout.split(" ")[0];
  expect(patchId).toMatch(/^[0-9a-f]{40}$/);
  git("checkout", "-q", "--", "src/a.txt");
  // The records: the done nodes' verifier records, CLEARed as the loop does (LP-cccc before this change: no patch-id).
  for (const node of ["LP-aaaa", "LP-cccc", "LP-eeee"]) ok(cli(["write", "-"], verifierDraft(node)));
  const store = readFileSync(join(WS, "trace/records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  recordA = store.find((r) => r.claim_id === "loop:lp-aaaa").record_id;
  recordC = store.find((r) => r.claim_id === "loop:lp-cccc").record_id;
  recordE = store.find((r) => r.claim_id === "loop:lp-eeee").record_id;
  ok(cli(["act", recordA, "loop", "CLEAR", "--ref", "LP-aaaa", "--note", `base ${base.slice(0, 12)}; patch 0a1b2c3d4e5f; patch-id ${patchId}; pnpm test passed`]));
  // LP-cccc was CLEARed before this change: an unchained (1.0) CLEAR with no patch-id, as an older kit wrote it.
  const [legacy] = appendActions([{ record_id: recordC, consumer: "loop", action: "CLEAR", ref: "LP-cccc", note: `base ${base.slice(0, 12)}; patch 0a1b2c3d4e5f; pnpm test passed` }], { storePath: join(WS, "trace/records.jsonl"), now: new Date().toISOString(), policyVersion: 5 });
  expect(legacy.stored).toBe(true);
  // LP-eeee: a CLEAR by this kit (chained) that forgot its patch-id — fail safe, never legacy.
  ok(cli(["act", recordE, "loop", "CLEAR", "--ref", "LP-eeee", "--note", `base ${base.slice(0, 12)}; patch 0a1b2c3d4e5f; pnpm test passed`]));
  writeFileSync(
    join(WS, "loop-plan.md"),
    `## Plan

| id | description | after | status | record | missing | origin | notes | scope | check |
|---|---|---|---|---|---|---|---|---|---|
| LP-aaaa | Fix line 5 — done when: line 5 reads fixed | — | done | ${recordA} | — | human | — | src/a.txt | pnpm test |
| LP-bbbb | Build on it — done when: x | LP-aaaa | blocked | — | — | human | — | src/b.txt | pnpm test |
| LP-cccc | An older fix — done when: y | — | done | ${recordC} | — | human | — | src/c.txt | pnpm test |
| LP-dddd | Build on the older fix — done when: z | LP-cccc | blocked | — | — | human | — | src/d.txt | pnpm test |
| LP-eeee | A fix whose CLEAR lost its patch-id — done when: w | — | done | ${recordE} | — | human | — | src/e.txt | pnpm test |
| LP-ffff | Build on it — done when: v | LP-eeee | blocked | — | — | human | — | src/f.txt | pnpm test |
`,
  );
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("a done node satisfies `after` only once its change is in HEAD", () => {
  beforeEach(resetMain);

  it("an unmerged branch: not landed — the dependent waits, plan-items refuses it, plan-lint warns", () => {
    git("checkout", "-q", "-b", "feature-unmerged");
    git("apply", patchFile);
    git("commit", "-qam", "fix line 5");
    git("checkout", "-q", "main");
    expect(ready()).toEqual(["LP-dddd"]); // the legacy node (no patch-id) still counts as landed
    const items = cli(["plan-items", "LP-bbbb", "--level", "L1"]);
    expect(items.status).toBe(1);
    expect(items.stdout + items.stderr).toMatch(/waits on LP-aaaa \(done, not landed in HEAD\)/);
    const lint = cli(["plan-lint"]);
    expect(lint.stdout + lint.stderr).toMatch(/\[done-unlanded\] .*LP-aaaa/);
    expect(lint.stdout + lint.stderr).toMatch(/\[done-legacy\] .*LP-cccc/);
    expect(lint.stdout + lint.stderr).toMatch(/\[done-unlanded\] .*LP-eeee.*records no patch-id or commit/); // fail safe, not legacy
  });

  it("a merge commit of the branch: landed", () => {
    git("checkout", "-q", "-b", "feature-merge");
    git("apply", patchFile);
    git("commit", "-qam", "fix line 5");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge", "feature-merge");
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("a squash of two commits that together make the change: landed", () => {
    git("checkout", "-q", "-b", "feature-squash");
    write(withLine(LINES, 4, "line 5 — fix"));
    git("commit", "-qam", "half");
    write(withLine(LINES, 4, "line 5 — fixed"));
    git("commit", "-qam", "rest");
    git("checkout", "-q", "main");
    git("merge", "-q", "--squash", "feature-squash");
    git("commit", "-qm", "squashed");
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("a cherry-pick onto a moved main: landed", () => {
    git("checkout", "-q", "-b", "feature-pick");
    git("apply", patchFile);
    git("commit", "-qam", "fix line 5");
    const pick = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    writeFileSync(join(P, "src/other.txt"), "other\n");
    git("add", "-A");
    git("commit", "-qm", "unrelated");
    git("cherry-pick", pick);
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("a later change next to the hunk: still landed, where `git apply --reverse --check` fails", () => {
    git("apply", patchFile);
    git("commit", "-qam", "fix line 5");
    write(withLine(withLine(LINES, 4, "line 5 — fixed"), 5, "line 6 — changed later"));
    git("commit", "-qam", "later, next to the hunk");
    expect(spawnSync("git", ["apply", "--reverse", "--check", patchFile], { cwd: P }).status).not.toBe(0); // the false negative avoided
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("a combined commit: unknown without a trailer, landed with `Plan: LP-aaaa`", () => {
    git("apply", patchFile);
    writeFileSync(join(P, "src/other.txt"), "other\n");
    git("add", "-A");
    git("commit", "-qm", "two things at once");
    expect(ready()).toEqual(["LP-dddd"]);
    git("commit", "-q", "--amend", "-m", "two things at once\n\nPlan: LP-aaaa");
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("a cherry-pick onto a main that changed a line next to the hunk first: unknown (fail safe); a Plan trailer lands it", () => {
    git("checkout", "-q", "-b", "feature-diverged");
    git("apply", patchFile);
    git("commit", "-qam", "fix line 5");
    const pick = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    write(withLine(LINES, 6, "line 7 — changed first"));
    git("commit", "-qam", "next to the hunk, before landing");
    git("cherry-pick", pick);
    expect(ready()).toEqual(["LP-dddd"]); // the context differs, so the patch-id does too: unknown, never a false landed
    git("commit", "-q", "--amend", "-m", "fix line 5\n\nPlan: LP-aaaa");
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });

  it("only a real trailer on a non-merge commit counts: a quoted 'Plan:' in a body or a merge's trailer does not", () => {
    git("apply", patchFile);
    writeFileSync(join(P, "src/other.txt"), "other\n");
    git("add", "-A");
    git("commit", "-qm", "bundle\n\nPlan: LP-aaaa is mentioned in prose here, not as a trailer.\n\nSigned-off-by: t <t@example.com>");
    expect(ready()).toEqual(["LP-dddd"]);
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(P, "src/side.txt"), "side\n");
    git("add", "-A");
    git("commit", "-qm", "side");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge side\n\nPlan: LP-aaaa", "side");
    expect(ready()).toEqual(["LP-dddd"]);
  });

  it("a plan where no open node waits on a done one runs no history scan", () => {
    const shimDir = join(T, "gitshim");
    const log = join(T, "git-calls.log");
    mkdirSync(shimDir, { recursive: true });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho "$*" >> ${log}\nexec ${realGit} "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const plan = join(T, "lone-plan.md");
    writeFileSync(plan, readFileSync(join(WS, "loop-plan.md"), "utf8").replace(/\| LP-aaaa \| blocked/g, "| — | blocked").replace(/\| (LP-cccc|LP-eeee) \| blocked/g, "| — | blocked"));
    const r = cli(["plan-ready", "--plan", plan], undefined, { PATH: `${shimDir}:${process.env.PATH}` });
    ok(r);
    expect(JSON.parse(r.stdout)).toEqual(["LP-bbbb", "LP-dddd", "LP-ffff"]);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toMatch(/(^|\n)log -p|patch-id/);
  });

  it("a human LAND lands it (and is refused from inside Claude Code or for another consumer)", () => {
    expect(ready()).toEqual(["LP-dddd"]);
    const inside = cli(["act", recordA, "human", "LAND", "--ref", "LP-aaaa", "--note", "rebased onto release/2"], undefined, { CLAUDECODE: "1" });
    expect(inside.status).toBe(2);
    expect(inside.stderr).toMatch(/LAND refused: .*human's step/);
    const loop = cli(["act", recordA, "loop", "LAND", "--ref", "LP-aaaa"]);
    expect(loop.status).toBe(1);
    expect(loop.stdout).toMatch(/consumer human and --ref/);
    ok(cli(["act", recordA, "human", "LAND", "--ref", "LP-aaaa", "--note", "rebased onto release/2"]));
    expect(ready()).toEqual(["LP-bbbb", "LP-dddd"]);
  });
});
