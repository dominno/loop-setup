// End-to-end lifecycle of the kit on the REAL stack (no mocks): real git (a bare remote, two clones,
// worktrees), real symlinks, the real installed shim run as a process, temp Claude config dirs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { STATE_BRANCH, stateGitDir, workspaceDir } from "./layout.mjs";
import { install, mergeSettings, normalizeRemote, renderKit, uninstall, verifyInstall } from "./install.mjs";
import { sessionContext, sessionStart, stop } from "./hooks.mjs";

let T;
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// A clean environment: no inherited workspace, store or Claude config.
const envFor = (home, extra = {}) => {
  const e = { ...process.env, HOME: join(home, ".."), CLAUDE_CONFIG_DIR: home };
  delete e.LOOP_SETUP_WORKSPACE;
  delete e.TRACE_STORE;
  delete e.CLAUDE_ENV_FILE;
  return { ...e, ...extra };
};
const shimOf = (home) => join(home, "loop-setup/bin/loop-setup");
const run = (home, cwd, args, input, extra) => spawnSync(shimOf(home), args, { cwd, encoding: "utf8", input, env: envFor(home, extra) });
const mkHome = (name) => {
  const h = join(T, name, ".claude");
  mkdirSync(h, { recursive: true });
  return h;
};
const draft = (claim) =>
  JSON.stringify({ writer_id: "test", claim_id: claim, claim_text: claim, claim_type: "factual", evidence: [{ kind: "command", ref: "echo ok", result: "ok" }], final_status: "accept", reason: "checked", provenance: { workflow: "test" } });

let kitSrc; // a git repo holding a committed copy of the working-tree kit (the source an install reads)
let remote; // a bare remote that projects clone from and push the state branch to

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "ls-life-")));
  kitSrc = join(T, "kitsrc");
  mkdirSync(kitSrc);
  cpSync(KIT_ROOT, join(kitSrc, "kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  git(kitSrc, "init", "-q");
  git(kitSrc, "add", "-A");
  git(kitSrc, "commit", "-qm", "kit");
  // The kit's own remote, with the commit on main: denylist-check from an installed kit gates on
  // verify-kit, which anchors the install to a protected ref of the kit source's origin.
  const kitRemote = join(T, "kit.git");
  git(T, "init", "-q", "--bare", kitRemote);
  git(kitSrc, "remote", "add", "origin", kitRemote);
  git(kitSrc, "push", "-q", "origin", "HEAD:refs/heads/main");
  remote = join(T, "remote.git");
  git(T, "init", "-q", "--bare", remote);
  const seed = join(T, "seed");
  git(T, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "README.md"), "app\n");
  writeFileSync(join(seed, ".gitignore"), "/.claude/loop-workspace\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

const clone = (name) => {
  const d = join(T, name);
  git(T, "clone", "-q", "--branch", "main", remote, d);
  return d;
};

describe("install / uninstall (temp ~/.claude)", () => {
  it("installs the committed kit: files, rendered commands, shim, owned settings — and is idempotent", () => {
    const home = mkHome("h-install");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    const m = install({ from: kitSrc, claudeHome: home });
    const kit = join(home, "loop-setup/kit");
    expect(m.source.commit).toBe(git(kitSrc, "rev-parse", "HEAD"));
    expect(existsSync(join(kit, "bin/loop-setup.mjs"))).toBe(true);
    expect(existsSync(join(kit, "workflows/loop-iteration.js"))).toBe(true);
    expect(Object.keys(m.files).some((f) => f.endsWith(".test.mjs") || f.startsWith("test/"))).toBe(false); // dev-only files stay out
    const cmds = readdirSync(join(home, "commands"));
    expect(cmds).toEqual(expect.arrayContaining(["critic-round.md", "dream.md", "loop-tick.md"]));
    for (const c of cmds) expect(readFileSync(join(home, "commands", c), "utf8"), c).not.toContain("{{KIT}}");
    expect(readFileSync(join(home, "commands/critic-round.md"), "utf8")).toContain(`${kit}/workflows/critic-panel.js`);
    const s1 = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(s1.model).toBe("x");
    expect(s1.permissions.allow).toContain("Bash(ls)");
    expect(s1.permissions.allow).toContain(`Read(/${kit}/**)`);
    expect(s1.permissions.deny).toContain(`Edit(/${kit}/**)`);
    expect(s1.permissions.allow.filter((r) => /^Bash\(loop-setup(:\*| \*)?\)$/.test(r))).toEqual([]); // never a blanket grant (bench writers)
    expect(s1.hooks.Stop.map((g) => g.hooks[0].command)).toEqual(["mine", `"${shimOf(home)}" hook stop`]);
    expect(s1.hooks.SessionStart).toHaveLength(1);
    install({ from: kitSrc, claudeHome: home });
    const s2 = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(s2).toEqual(s1);
    expect(verifyInstall(home).ok).toBe(true);
    const where = run(home, T, ["where", "--json"]);
    expect(JSON.parse(where.stdout)).toMatchObject({ ok: false, code: "NO_REPO" });
    expect(where.status).toBe(2);
  });

  it("refuses to touch a settings.json that does not parse, and keeps the user's first backup across installs", () => {
    const home = mkHome("h-badjson");
    const original = '{ // my settings\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls)"] },\n}\n';
    writeFileSync(join(home, "settings.json"), original);
    expect(() => install({ from: kitSrc, claudeHome: home })).toThrow(/does not parse/);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(original); // untouched
    expect(existsSync(join(home, "loop-setup/kit"))).toBe(false); // nothing installed
    const valid = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } });
    writeFileSync(join(home, "settings.json"), valid);
    install({ from: kitSrc, claudeHome: home });
    install({ from: kitSrc, claudeHome: home });
    uninstall({ claudeHome: home });
    expect(readFileSync(join(home, "settings.json.loop-setup.bak"), "utf8")).toBe(valid); // the original, not a kit-written copy
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual(JSON.parse(valid));
  });

  it("refuses to overwrite a command it did not install (unless --force, keeping a .bak)", () => {
    const home = mkHome("h-clash");
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands/dream.md"), "my own dream\n");
    expect(() => install({ from: kitSrc, claudeHome: home })).toThrow(/dream\.md/);
    expect(existsSync(join(home, "loop-setup/kit"))).toBe(false);
    install({ from: kitSrc, claudeHome: home, force: true });
    expect(readFileSync(join(home, "commands/dream.md.bak"), "utf8")).toBe("my own dream\n");
  });

  it("uninstall removes exactly what it owns and keeps the user's settings, edited commands and workspaces", () => {
    const home = mkHome("h-uninstall");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    install({ from: kitSrc, claudeHome: home });
    writeFileSync(join(home, "commands/qa-pass.md"), "edited by the user\n");
    mkdirSync(workspaceDir(home, "keep-1"), { recursive: true });
    const r = uninstall({ claudeHome: home });
    expect(r.kept).toEqual([join(home, "commands/qa-pass.md")]);
    expect(readdirSync(join(home, "commands"))).toEqual(["qa-pass.md"]);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    expect(existsSync(join(home, "loop-setup/kit"))).toBe(false);
    expect(existsSync(workspaceDir(home, "keep-1"))).toBe(true);
  });

  it("detects a modified installed file, and denylist-check in an adopter project then fails closed", () => {
    const home = mkHome("h-tamper");
    install({ from: kitSrc, claudeHome: home });
    const proj = clone("p-tamper");
    writeFileSync(join(proj, "x.patch"), "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+x\n");
    const ok = run(home, proj, ["denylist-check", "--patch", "x.patch"]);
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    const f = join(home, "loop-setup/kit/workflows/loop-iteration.js");
    writeFileSync(f, readFileSync(f, "utf8").replace("/^kit(\\/|$)/i, ", ""));
    expect(verifyInstall(home).problems).toContain("modified workflows/loop-iteration.js");
    const bad = run(home, proj, ["denylist-check", "--patch", "x.patch"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toMatch(/sha256 mismatch/);
  });
});

describe("pure helpers", () => {
  it("renders {{KIT}} (absolute // form inside a permission rule)", () => {
    expect(renderKit("scriptPath: {{KIT}}/workflows/a.js, Edit({{KIT}}/x.md)", "/h/.claude/loop-setup/kit")).toBe("scriptPath: /h/.claude/loop-setup/kit/workflows/a.js, Edit(//h/.claude/loop-setup/kit/x.md)");
  });

  it("normalizes remotes across ssh, https, credentials and the cloud git proxy", () => {
    for (const u of ["git@github.com:Dominno/loop-setup.git", "https://github.com/dominno/loop-setup", "https://x:tok@github.com/dominno/loop-setup.git/", "http://local_proxy@127.0.0.1:41000/git/dominno/loop-setup"]) {
      expect(normalizeRemote(u), u).toBe(u.includes("127.0.0.1") ? "127.0.0.1/dominno/loop-setup" : "github.com/dominno/loop-setup");
    }
  });

  it("mergeSettings removes only the previous owned entries", () => {
    const owned = { hooks: { Stop: [{ hooks: [{ type: "command", command: "k" }] }] }, allow: ["A"], deny: ["D"] };
    const merged = mergeSettings({ hooks: { Stop: [{ hooks: [{ type: "command", command: "u" }] }] }, permissions: { allow: ["U"] } }, owned);
    expect(mergeSettings(merged, null, owned)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "u" }] }] }, permissions: { allow: ["U"] } });
  });
});

describe("init / sync / restore across two machines (bare remote, two clones, two homes)", () => {
  let homeA;
  let projA;
  let wsId;

  it("init creates the workspace, binds it (marker, ignored link, exclude block, grant) and leaves git status clean", () => {
    homeA = mkHome("h-a");
    install({ from: kitSrc, claudeHome: homeA });
    projA = clone("p-a");
    const r = run(homeA, projA, ["init"]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    wsId = out.id;
    const ws = workspaceDir(homeA, wsId);
    expect(out).toMatchObject({ workspace: ws, fromLegacy: false, ignored: true });
    expect(git(projA, "config", "--get", "loop-setup.workspace")).toBe(wsId);
    expect(lstatSync(join(projA, ".claude/loop-workspace")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(projA, ".claude/loop-workspace"))).toBe(ws);
    expect(readFileSync(join(projA, ".git/info/exclude"), "utf8")).toContain("/.claude/loop-workspace");
    expect(JSON.parse(readFileSync(join(projA, ".claude/settings.local.json"), "utf8")).permissions.additionalDirectories).toEqual([ws]);
    expect(git(projA, "status", "--porcelain", "--ignored=no", "--", ".claude/loop-workspace")).toBe("");
    for (const f of ["index.md", "loop-plan.md", "trace/records.jsonl", "workspace.json", ".gitattributes"]) expect(existsSync(join(ws, f)), f).toBe(true);
    expect(git(ws, "--git-dir", stateGitDir(homeA, wsId), "rev-parse", "--abbrev-ref", "HEAD")).toBe(STATE_BRANCH); // the state repo lives outside the workspace (C3)
    const lint = run(homeA, projA, ["lint"]);
    expect(lint.status, lint.stderr).toBe(0);
    expect(JSON.parse(lint.stdout)).toMatchObject({ ok: true, records: 0, store: join(ws, "trace/records.jsonl") });
    expect(run(homeA, projA, ["init"]).status).toBe(2); // already initialised
  });

  it("a record written in the project lands in the workspace, and sync publishes the state branch", () => {
    const w = run(homeA, projA, ["write", "-"], draft("demo:a1"));
    expect(w.status, w.stderr).toBe(0);
    expect(JSON.parse(w.stdout)[0]).toMatchObject({ stored: true });
    const s = run(homeA, projA, ["sync", "--message", "a1"]);
    expect(s.status, s.stderr + s.stdout).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: true, committed: true, pushed: true });
    expect(git(T, "ls-remote", "--heads", remote, STATE_BRANCH)).toMatch(new RegExp(`refs/heads/${STATE_BRANCH}$`));
    expect(git(projA, "status", "--porcelain")).toBe(""); // the project tree never sees the state
  });

  it("restore on a fresh machine clones the state branch under the same id; concurrent appends merge as a union", () => {
    const homeB = mkHome("h-b");
    install({ from: kitSrc, claudeHome: homeB });
    const projB = clone("p-b");
    const r = run(homeB, projB, ["restore"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: wsId, restored: true, workspace: workspaceDir(homeB, wsId) });
    expect(run(homeB, projB, ["write", "-"], draft("demo:b1")).status).toBe(0);
    expect(run(homeA, projA, ["write", "-"], draft("demo:a2")).status).toBe(0);
    expect(JSON.parse(run(homeB, projB, ["sync"]).stdout)).toMatchObject({ ok: true, pushed: true });
    const sa = run(homeA, projA, ["sync"]);
    expect(sa.status, sa.stdout).toBe(0);
    expect(JSON.parse(sa.stdout)).toMatchObject({ ok: true, pulled: "merged", pushed: true });
    const lint = JSON.parse(run(homeA, projA, ["lint"]).stdout);
    expect(lint).toMatchObject({ ok: true, records: 3 });
    expect(JSON.parse(run(homeB, projB, ["restore"]).stdout)).toMatchObject({ restored: false, pulled: "merged" });
    expect(JSON.parse(run(homeB, projB, ["lint"]).stdout)).toMatchObject({ ok: true, records: 3 });
  });

  it("a linked worktree reads the same workspace but cannot write records (maker/checker)", () => {
    const wt = join(T, "wt-a");
    git(projA, "worktree", "add", "-q", wt);
    const where = JSON.parse(run(homeA, wt, ["where", "--json"]).stdout);
    expect(where).toMatchObject({ ok: true, mode: "bound", workspace: workspaceDir(homeA, wsId), inWorktree: true });
    const w = run(homeA, wt, ["write", "-"], draft("demo:wt"));
    expect(w.status).toBe(2);
    expect(w.stderr).toMatch(/WORKTREE_WRITE/);
    expect(run(homeA, wt, ["init"]).status).toBe(2);
  });

  it("doctor is green for a bound, synced project (apart from the auto-restore advice)", () => {
    const d = run(homeA, projA, ["doctor", "--json"]);
    const checks = JSON.parse(d.stdout);
    expect(checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(d.status).toBe(0);
  });

  it("hooks: session-start heals the link and injects the context; stop asks for a sync only when state is unsynced", () => {
    const env = envFor(homeA, { CLAUDE_ENV_FILE: join(T, "envfile") });
    unlinkSync(join(projA, ".claude/loop-workspace"));
    const out = sessionStart({ cwd: projA }, { env });
    expect(lstatSync(join(projA, ".claude/loop-workspace")).isSymbolicLink()).toBe(true);
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).toContain(wsId);
    expect(readFileSync(join(T, "envfile"), "utf8")).toContain(join(homeA, "loop-setup/bin"));
    expect(stop({ cwd: projA }, { env })).toBe(null);
    expect(run(homeA, projA, ["write", "-"], draft("demo:a3")).status).toBe(0);
    expect(stop({ cwd: projA }, { env })).toMatchObject({ decision: "block" });
    expect(stop({ cwd: projA, stop_hook_active: true }, { env })).toBe(null);
    expect(run(homeA, projA, ["sync"]).status).toBe(0);
    expect(stop({ cwd: projA }, { env })).toBe(null);
  });

  it("hooks: nothing in an unrelated repo; auto-restore in a fresh clone of an opted-in project", () => {
    const homeC = mkHome("h-c");
    install({ from: kitSrc, claudeHome: homeC });
    const other = join(T, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    expect(sessionStart({ cwd: other }, { env: envFor(homeC) })).toBe(null);
    const projC = clone("p-c");
    expect(sessionStart({ cwd: projC }, { env: envFor(homeC) })).toBe(null); // not opted in
    install({ from: kitSrc, claudeHome: homeC, autoRestore: [remote] });
    const out = sessionStart({ cwd: projC }, { env: envFor(homeC) });
    expect(out.hookSpecificOutput.additionalContext).toContain(`Restored this session from ${STATE_BRANCH}`);
    expect(existsSync(join(workspaceDir(homeC, wsId), "trace/records.jsonl"))).toBe(true);
    expect(git(projC, "config", "--get", "loop-setup.workspace")).toBe(wsId);
  });

  it("hook processes never fail: malformed stdin exits 0", () => {
    for (const h of ["session-start", "stop"]) {
      const r = run(homeA, projA, ["hook", h], "{not json");
      expect(r.status, h).toBe(0);
    }
  });
});

describe("init --from-legacy (an adopter migrating its in-repo .claude/memory)", () => {
  it("moves the legacy state into the workspace: same records, wiki and plan", () => {
    const home = mkHome("h-legacy");
    install({ from: kitSrc, claudeHome: home });
    const proj = clone("p-legacy");
    cpSync(join(KIT_ROOT, "test/fixtures/legacy-v1"), join(proj, ".claude/memory"), { recursive: true });
    const before = JSON.parse(run(home, proj, ["lint"]).stdout);
    expect(before).toMatchObject({ ok: true, records: 133 });
    const r = run(home, proj, ["init"]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.fromLegacy).toBe(true);
    const after = JSON.parse(run(home, proj, ["lint"]).stdout);
    expect(after).toMatchObject({ ok: true, records: 133, store: join(out.workspace, "trace/records.jsonl") });
    expect(JSON.parse(run(home, proj, ["wiki-check"]).stdout)).toMatchObject({ ok: true });
  });
});

describe("sessionContext budget", () => {
  it("stays within the hook cap even with a huge catalog", () => {
    const ws = join(T, "big-ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "index.md"), Array.from({ length: 2000 }, (_, i) => `| t${i} | ${"x".repeat(80)} | [topics/t${i}.md](./topics/t${i}.md) |`).join("\n"));
    const ctx = sessionContext({ ok: true, mode: "bound", workspace: ws, workspaceId: "big-1", warnings: [] });
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).toContain("Too long to inline");
  });
});
