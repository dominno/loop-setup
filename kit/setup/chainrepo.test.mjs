// The tamper-evident record store (phase C, goal C4) on the REAL stack: real git (a bare remote,
// clones on two homes), union merges and a rebase of two writers, the installed shim run as a
// process, the SessionStart hook in-process, and machine-local anchors in temp Claude homes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { anchorsRoot, stateGitDir, workspaceDir } from "./layout.mjs";
import { install } from "./install.mjs";
import { sessionStart, stop } from "./hooks.mjs";

let T;
let kitSrc;
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// A human's terminal: no CLAUDECODE (the tests themselves run inside Claude Code's Bash).
const envFor = (home, extra = {}) => {
  const e = { ...process.env, HOME: join(home, ".."), CLAUDE_CONFIG_DIR: home };
  for (const k of ["LOOP_SETUP_WORKSPACE", "TRACE_STORE", "CLAUDE_ENV_FILE", "CLAUDECODE", "GIT_DIR", "GIT_WORK_TREE"]) delete e[k];
  return { ...e, ...extra };
};
const shim = (home) => join(home, "loop-setup/bin/loop-setup");
const run = (home, cwd, args, input, extra) => spawnSync(shim(home), args, { cwd, encoding: "utf8", input, env: envFor(home, extra) });
const runAsync = (home, cwd, args, input) =>
  new Promise((done) => {
    const p = spawn(shim(home), args, { cwd, env: envFor(home) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => done({ status, out }));
    p.stdin.end(input);
  });
const draft = (claim) => JSON.stringify({ writer_id: "test", claim_id: claim, claim_text: claim, claim_type: "factual", evidence: [{ kind: "command", ref: "echo ok", result: "ok" }], final_status: "accept", reason: "checked", provenance: { workflow: "test" } });
const ok = (r) => expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
const mkHome = (name) => {
  const h = join(T, name, ".claude");
  mkdirSync(h, { recursive: true });
  install({ from: kitSrc, claudeHome: h });
  return h;
};
function project(name) {
  const remote = join(T, `${name}.git`);
  git(T, "init", "-q", "--bare", remote);
  const seed = join(T, `${name}-seed`);
  git(T, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "README.md"), "app\n");
  writeFileSync(join(seed, ".gitignore"), "/.claude/loop-workspace\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { remote, clone: (dir) => (git(T, "clone", "-q", "--branch", "main", remote, join(T, dir)), join(T, dir)) };
}
const storeOf = (home, id) => join(workspaceDir(home, id), "trace/records.jsonl");
const lines = (home, id) => readFileSync(storeOf(home, id), "utf8").trim().split("\n");
const parsed = (home, id) => lines(home, id).map((l) => JSON.parse(l));
const claims = (home, id) => parsed(home, id).map((v) => (v.kind === "record" ? v.claim_id : `act:${v.action}`));
const lint = (home, cwd) => run(home, cwd, ["lint"]);
const anchorsFile = (home, id) => join(anchorsRoot(home), `${id}.jsonl`);

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "ls-chain-")));
  kitSrc = join(T, "kitsrc");
  mkdirSync(kitSrc);
  cpSync(KIT_ROOT, join(kitSrc, "kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  git(kitSrc, "init", "-q");
  git(kitSrc, "add", "-A");
  git(kitSrc, "commit", "-qm", "kit");
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("two writers on two machines: union merges and a rebase keep every chain", () => {
  let p;
  let homeA;
  let homeB;
  let projA;
  let projB;
  let id;

  beforeAll(() => {
    p = project("c1");
    homeA = mkHome("ca");
    projA = p.clone("c1-a");
    const init = run(homeA, projA, ["init"]);
    ok(init);
    id = JSON.parse(init.stdout).id;
    ok(run(homeA, projA, ["sync"]));
  });

  it("each write is chained and anchored by its writer; the writer ids differ per machine", () => {
    ok(run(homeA, projA, ["write", "-"], draft("demo:a1")));
    const [a1] = parsed(homeA, id);
    expect(a1).toMatchObject({ schema_version: "trace-lite/1.1", chain: { prev: null }, provenance: { workspace: id } });
    expect(Number(a1.policy_version)).toBeGreaterThanOrEqual(4); // the current policy (v5 since C5's LAND); chains need v4 or later
    expect(a1.chain.w).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(join(anchorsRoot(homeA), `${id}.writer`), "utf8").trim()).toBe(a1.chain.w);
    expect(readFileSync(anchorsFile(homeA, id), "utf8")).toContain(a1.chain.w); // the writer anchored its own line
    ok(run(homeA, projA, ["sync"]));
    homeB = mkHome("cb");
    projB = p.clone("c1-b");
    ok(run(homeB, projB, ["restore"]));
    ok(run(homeB, projB, ["write", "-"], draft("demo:b1")));
    expect(parsed(homeB, id)[1].chain.w).not.toBe(a1.chain.w);
  });

  it("a union merge keeps both sides (local side first) and a late 1.0 line from an older kit is only a warning", async () => {
    // B also carries a 1.0 line, as a machine still on an older kit would write it.
    const { writeRecords } = await import("../trace/lib.mjs");
    const [old] = writeRecords([JSON.parse(draft("demo:b-old"))], { storePath: storeOf(homeB, id), now: new Date().toISOString(), policyVersion: 3, commit: "abc1234def56" });
    expect(old).toMatchObject({ stored: true, schema_version: "trace-lite/1.0" });
    ok(run(homeB, projB, ["sync"]));
    ok(run(homeA, projA, ["write", "-"], draft("demo:a2")));
    const [a2] = parsed(homeA, id).slice(-1);
    ok(run(homeA, projA, ["act", a2.record_id, "dream", "HOLD", "--note", "n"]));
    const s = run(homeA, projA, ["sync"]);
    ok(s);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: true, pulled: "merged" });
    expect(claims(homeA, id)).toEqual(["demo:a1", "demo:a2", "act:HOLD", "demo:b1", "demo:b-old"]);
    const l = lint(homeA, projA);
    ok(l);
    expect(l.stderr).toMatch(/unchained line .* upgrade every machine/);
    ok(run(homeB, projB, ["sync"]));
    expect(claims(homeB, id)).toEqual(claims(homeA, id));
    ok(lint(homeB, projB));
  });

  it("a rebase of one side onto the other keeps every chain", () => {
    ok(run(homeA, projA, ["write", "-"], draft("demo:a3")));
    ok(run(homeA, projA, ["sync"]));
    ok(run(homeB, projB, ["write", "-"], draft("demo:b2")));
    const ws = workspaceDir(homeB, id);
    const sg = (...a) => git(ws, `--git-dir=${stateGitDir(homeB, id)}`, `--work-tree=${ws}`, "-c", "core.hooksPath=/dev/null", ...a);
    sg("add", "-A");
    sg("commit", "-qm", "b2");
    sg("fetch", "-q", "origin", "claude/loop-state");
    sg("rebase", "-q", "FETCH_HEAD");
    expect(claims(homeB, id).slice(-2)).toEqual(["demo:a3", "demo:b2"]);
    ok(lint(homeB, projB));
    ok(run(homeB, projB, ["sync"]));
    ok(run(homeA, projA, ["sync"]));
    ok(lint(homeA, projA));
  });

  it("editing or deleting a middle line turns lint red", () => {
    const file = storeOf(homeA, id);
    const original = readFileSync(file, "utf8");
    const ls = original.trim().split("\n");
    const i = ls.findIndex((l) => l.includes('"demo:a2"'));
    writeFileSync(file, [...ls.slice(0, i), ls[i].replace('"reason":"checked"', '"reason":"forged"'), ...ls.slice(i + 1)].join("\n") + "\n");
    const edited = lint(homeA, projA);
    expect(edited.status).toBe(1);
    writeFileSync(file, [...ls.slice(0, i), ...ls.slice(i + 1)].join("\n") + "\n");
    const deleted = lint(homeA, projA);
    expect(deleted.status).toBe(1);
    expect(deleted.stdout + deleted.stderr).toMatch(/chain\.prev does not match the previous line of writer/);
    writeFileSync(file, original);
    ok(lint(homeA, projA));
  });
});

describe("anchors: SessionStart checkpoints every stream; a dropped count is caught everywhere and never re-anchored", () => {
  let home;
  let proj;
  let id;

  beforeAll(() => {
    const p = project("c2");
    home = mkHome("cx");
    proj = p.clone("c2-a");
    const init = run(home, proj, ["init"]);
    ok(init);
    id = JSON.parse(init.stdout).id;
    for (const c of ["demo:x1", "demo:x2", "demo:x3"]) ok(run(home, proj, ["write", "-"], draft(c)));
    ok(run(home, proj, ["sync"]));
  });

  it("SessionStart verifies and anchors; deleting the writer's last (anchored) line is reported by lint, doctor, SessionStart and sync", () => {
    const env = envFor(home);
    const ctx = sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext;
    expect(ctx).not.toMatch(/integrity check FAILED/);
    const anchorsBefore = readFileSync(anchorsFile(home, id), "utf8");
    const file = storeOf(home, id);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.trim().split("\n").slice(0, -1).join("\n") + "\n"); // the tail, chain-consistent
    const l = lint(home, proj);
    expect(l.status).toBe(1);
    expect(l.stdout + l.stderr).toMatch(/has 2 line\(s\), 3 anchored/);
    const d = run(home, proj, ["doctor", "--json"]);
    expect(d.status).toBe(1);
    expect(JSON.parse(d.stdout).find((c) => c.check === "record store chain and anchors")).toMatchObject({ level: "fail" });
    const ctx2 = sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext;
    expect(ctx2).toMatch(/Record store integrity check FAILED: .*3 anchored .*not re-anchored/);
    expect(readFileSync(anchorsFile(home, id), "utf8")).toBe(anchorsBefore); // never re-anchored over a failure
    const s = run(home, proj, ["sync"]);
    expect(s.status).toBe(1);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: false, stage: "pre-lint" });
    writeFileSync(file, original);
    ok(lint(home, proj));
  });

  it("anchors reset is a human's step: refused under CLAUDECODE, recorded with its reason otherwise", () => {
    const file = storeOf(home, id);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.trim().split("\n").slice(0, -1).join("\n") + "\n");
    const refused = run(home, proj, ["anchors", "reset", "--reason", "restored from a behind remote"], undefined, { CLAUDECODE: "1" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/anchors reset refused: .*from inside Claude Code/);
    expect(run(home, proj, ["anchors", "reset"]).status).toBe(2); // a reason is required
    ok(run(home, proj, ["anchors", "reset", "--reason", "restored from a behind remote"]));
    ok(lint(home, proj));
    const d = JSON.parse(run(home, proj, ["doctor", "--json"]).stdout).find((c) => c.check === "record store chain and anchors");
    expect(d).toMatchObject({ level: "ok" });
    expect(d.detail).toMatch(/reset .*restored from a behind remote/);
    writeFileSync(file, original); // the line comes back: a later line of the same writer, nothing deleted
    ok(lint(home, proj));
  });

  it("a missing anchors file (with a writer id) and a corrupt anchors line are failures, never a silent skip", () => {
    const af = anchorsFile(home, id);
    const keep = readFileSync(af, "utf8");
    rmSync(af);
    const l = lint(home, proj);
    expect(l.status).toBe(1);
    expect(l.stdout + l.stderr).toMatch(/anchors file .* is missing/);
    writeFileSync(af, `${keep}{not json\n`);
    expect(lint(home, proj).status).toBe(1);
    expect(sessionStart({ cwd: proj }, { env: envFor(home) }).hookSpecificOutput.additionalContext).toMatch(/Record store integrity check FAILED: .*not valid JSON/);
    writeFileSync(af, keep);
    ok(lint(home, proj));
  });

  it("the Stop hook anchors what a sandboxed writer could not (its own checkpoint missing)", () => {
    ok(run(home, proj, ["write", "-"], draft("demo:stop-anchor")));
    const af = anchorsFile(home, id);
    const withOwn = readFileSync(af, "utf8");
    writeFileSync(af, withOwn.trim().split("\n").slice(0, -1).join("\n") + "\n"); // as if the writer could not append it
    ok(lint(home, proj)); // fewer checkpoints are no violation
    stop({ cwd: proj }, { env: envFor(home) });
    const last = JSON.parse(readFileSync(af, "utf8").trim().split("\n").pop());
    const w = parsed(home, id).slice(-1)[0].chain.w;
    expect(last.checkpoints.find((c) => c.w === w)).toMatchObject({ n: parsed(home, id).filter((v) => v.chain && v.chain.w === w).length });
  });

  it("a write never re-creates a deleted anchors file: lint stays red until a human resets", () => {
    const af = anchorsFile(home, id);
    const keep = readFileSync(af, "utf8");
    rmSync(af);
    ok(run(home, proj, ["write", "-"], draft("demo:after-rm")));
    const [rec] = parsed(home, id).slice(-1);
    ok(run(home, proj, ["act", rec.record_id, "dream", "HOLD", "--note", "after rm"]));
    expect(existsSync(af)).toBe(false);
    const l = lint(home, proj);
    expect(l.status).toBe(1);
    expect(l.stdout + l.stderr).toMatch(/anchors file .* is missing/);
    expect(sessionStart({ cwd: proj }, { env: envFor(home) }).hookSpecificOutput.additionalContext).toMatch(/integrity check FAILED: .*anchors file .* is missing/);
    expect(existsSync(af)).toBe(false); // nor does SessionStart
    writeFileSync(af, keep);
    ok(lint(home, proj));
  });

  it("a rejected first write on a fresh home (an explicit --store) leaves a writer id and an anchors file, so lint stays green", () => {
    const fresh = mkHome("fresh");
    const store = join(T, "scratch-store.jsonl");
    const bad = run(fresh, T, ["write", "-", "--store", store], JSON.stringify({ bad: 1 }));
    expect(bad.status).toBe(1);
    const l = run(fresh, T, ["lint", "--store", store]);
    expect(l.status, l.stdout + l.stderr).toBe(0);
    const withCommit = JSON.stringify({ ...JSON.parse(draft("demo:scratch")), provenance: { workflow: "test", commit: "abc1234def56" } }); // T is no git repo
    ok(run(fresh, T, ["write", "-", "--store", store], withCommit));
    ok(run(fresh, T, ["lint", "--store", store]));
  });

  it("two concurrent writes on one machine share the lock: both stored, the chain intact", async () => {
    const [r1, r2] = await Promise.all([runAsync(home, proj, ["write", "-"], draft("demo:par-1")), runAsync(home, proj, ["write", "-"], draft("demo:par-2"))]);
    expect(r1.status, r1.out).toBe(0);
    expect(r2.status, r2.out).toBe(0);
    expect(claims(home, id)).toEqual(expect.arrayContaining(["demo:par-1", "demo:par-2"]));
    ok(lint(home, proj));
  });

  it("a deleted writer id file is re-created; the old lines keep verifying (a new writer starts its own chain)", () => {
    rmSync(join(anchorsRoot(home), `${id}.writer`));
    ok(run(home, proj, ["write", "-"], draft("demo:new-writer")));
    const ws = new Set(parsed(home, id).filter((v) => v.chain).map((v) => v.chain.w));
    expect(ws.size).toBe(2);
    ok(lint(home, proj));
    expect(existsSync(anchorsFile(home, id))).toBe(true);
  });
});
