// The state repo outside the workspace (phase C, goal C3) on the REAL stack: real git (bare
// remotes, clones), the installed shim run as a process, temp Claude config dirs. Every planted
// case has a payload that writes a marker file; the guard must refuse before git can run it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { STATE_BRANCH, stateGitDir, stateRoot, workspaceDir } from "./layout.mjs";
import { install } from "./install.mjs";
import { sessionStart, stop } from "./hooks.mjs";

let T;
let kitSrc;
let M; // the marker directory every payload writes into
const TEMPLATE = readFileSync(join(KIT_ROOT, "templates/workspace/.gitattributes"), "utf8");

const sh = (cwd, cmd, args, env) => spawnSync(cmd, args, { cwd, encoding: "utf8", env });
const git = (cwd, ...a) => {
  const r = sh(cwd, "git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a]);
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** git on a workspace's state repo, explicit dirs (the test's own probe, never the kit's guard). */
const sgit = (home, id, ...a) => git(T, `--git-dir=${stateGitDir(home, id)}`, `--work-tree=${workspaceDir(home, id)}`, ...a);
// Each home has its own HOME (the parent dir), so its global ~/.gitconfig is the test's to write.
const envFor = (home, extra = {}) => {
  const e = { ...process.env, HOME: join(home, ".."), CLAUDE_CONFIG_DIR: home };
  for (const k of ["LOOP_SETUP_WORKSPACE", "TRACE_STORE", "CLAUDE_ENV_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_GLOBAL"]) delete e[k];
  return { ...e, ...extra };
};
const run = (home, cwd, args, input) => spawnSync(join(home, "loop-setup/bin/loop-setup"), args, { cwd, encoding: "utf8", input, env: envFor(home) });
const draft = (claim) =>
  JSON.stringify({ writer_id: "test", claim_id: claim, claim_text: claim, claim_type: "factual", evidence: [{ kind: "command", ref: "echo ok", result: "ok" }], final_status: "accept", reason: "checked", provenance: { workflow: "test" } });
const mkHome = (name) => {
  const h = join(T, name, ".claude");
  mkdirSync(h, { recursive: true });
  install({ from: kitSrc, claudeHome: h });
  return h;
};
/** A project: a bare remote with one commit on main, cloned as needed. */
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
const markers = () => readdirSync(M);
const payload = (name) => `sh -c 'touch ${M}/${name}; cat'`;
const ok = (r) => expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "ls-state-")));
  M = join(T, "markers");
  mkdirSync(M);
  kitSrc = join(T, "kitsrc");
  mkdirSync(kitSrc);
  cpSync(KIT_ROOT, join(kitSrc, "kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  git(kitSrc, "init", "-q");
  git(kitSrc, "add", "-A");
  git(kitSrc, "commit", "-qm", "kit");
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("the state git dir lives outside the workspace (init, sync, restore)", () => {
  it("init puts it at state/<id>.git, outside the grant; sync publishes; restore clones into state/<id>.git with the same HEAD", () => {
    const p = project("p1");
    const homeA = mkHome("a1");
    const projA = p.clone("p1-a");
    const init = run(homeA, projA, ["init"]);
    ok(init);
    const id = JSON.parse(init.stdout).id;
    const ws = workspaceDir(homeA, id);
    expect(existsSync(join(ws, ".git"))).toBe(false);
    expect(existsSync(join(stateGitDir(homeA, id), "HEAD"))).toBe(true);
    expect(sgit(homeA, id, "rev-parse", "--abbrev-ref", "HEAD")).toBe(STATE_BRANCH);
    expect(sgit(homeA, id, "config", "--get", "core.bare")).toBe("false");
    expect(sh(T, "git", ["--git-dir", stateGitDir(homeA, id), "config", "--get", "core.worktree"]).status).not.toBe(0); // the work tree is always explicit
    const grant = JSON.parse(readFileSync(join(projA, ".claude/settings.local.json"), "utf8")).permissions.additionalDirectories;
    expect(grant).toEqual([ws]);
    for (const dir of grant) expect(stateGitDir(homeA, id).startsWith(`${dir}/`)).toBe(false);
    expect(sgit(homeA, id, "status", "--porcelain")).toBe("");

    ok(run(homeA, projA, ["write", "-"], draft("demo:a1")));
    const s = run(homeA, projA, ["sync", "--message", "a1"]);
    ok(s);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: true, committed: true, pushed: true });

    const homeB = mkHome("b1");
    const projB = p.clone("p1-b");
    const r = run(homeB, projB, ["restore"]);
    ok(r);
    expect(JSON.parse(r.stdout)).toMatchObject({ id, restored: true, workspace: workspaceDir(homeB, id) });
    expect(existsSync(join(workspaceDir(homeB, id), ".git"))).toBe(false);
    expect(sgit(homeB, id, "rev-parse", "HEAD")).toBe(sgit(homeA, id, "rev-parse", "HEAD"));
    expect(sgit(homeB, id, "status", "--porcelain")).toBe("");
    expect(readdirSync(stateRoot(homeB))).toEqual([`${id}.git`]); // no temporary git dir left behind
    expect(JSON.parse(run(homeB, projB, ["lint"]).stdout)).toMatchObject({ ok: true, records: 1 });
    const doctor = JSON.parse(run(homeB, projB, ["doctor", "--json"]).stdout);
    expect(doctor.find((c) => c.check === "state repo outside the workspace")).toMatchObject({ level: "ok", detail: stateGitDir(homeB, id) });
  });
});

describe("a new-layout workspace behaves as before for the user", () => {
  it("hooks: dirty with a remote, SessionStart reports unsynced state and Stop blocks; synced, both quiet", () => {
    const p = project("p5");
    const home = mkHome("h5");
    const proj = p.clone("p5-a");
    ok(run(home, proj, ["init"]));
    ok(run(home, proj, ["sync"]));
    const env = envFor(home);
    expect(stop({ cwd: proj }, { env })).toBe(null);
    ok(run(home, proj, ["write", "-"], draft("demo:h5")));
    expect(sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext).toMatch(/Workspace has unsynced state \(1 changed file\(s\), 0 unpushed commit\(s\)\)/);
    expect(stop({ cwd: proj }, { env })).toMatchObject({ decision: "block" });
    ok(run(home, proj, ["sync"]));
    expect(stop({ cwd: proj }, { env })).toBe(null);
  });

  it("init refuses an existing state/<id>.git; restore moves an orphan state/<id>.git aside (kept) and clones", () => {
    const p = project("p6");
    const home = mkHome("h6");
    const proj = p.clone("p6-a");
    const init = run(home, proj, ["init"]);
    ok(init);
    const id = JSON.parse(init.stdout).id;
    ok(run(home, proj, ["sync"]));
    rmSync(workspaceDir(home, id), { recursive: true, force: true }); // the user deletes the workspace dir; its git dir stays
    const other = p.clone("p6-b");
    const again = run(home, other, ["init", "--id", id]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(new RegExp(`${id}\\.git already exists`));
    const r = run(home, other, ["restore"]);
    ok(r);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ id, restored: true });
    expect(out.orphan).toMatch(new RegExp(`state/${id}\\.git\\.orphan-[0-9a-f]+$`));
    expect(existsSync(join(out.orphan, "HEAD"))).toBe(true);
    expect(readdirSync(stateRoot(home)).sort()).toEqual([`${id}.git`, out.orphan.split("/").pop()].sort());
    expect(existsSync(join(workspaceDir(home, id), ".git"))).toBe(false);
    expect(sgit(home, id, "status", "--porcelain")).toBe("");
  });
});

describe("a workspace in the old layout (<ws>/.git) migrates at its next sync or restore", () => {
  let p;
  let home;
  let proj;
  let id;
  const toOldLayout = () => renameSync(stateGitDir(home, id), join(workspaceDir(home, id), ".git"));
  const oldGit = (...a) => git(T, `--git-dir=${join(workspaceDir(home, id), ".git")}`, ...a);

  beforeAll(() => {
    p = project("p2");
    home = mkHome("m2");
    proj = p.clone("p2-m");
    const init = run(home, proj, ["init"]);
    ok(init);
    id = JSON.parse(init.stdout).id;
    ok(run(home, proj, ["write", "-"], draft("demo:m1")));
    ok(run(home, proj, ["sync"]));
    ok(run(home, proj, ["write", "-"], draft("demo:m2")));
    ok(run(home, proj, ["sync"]));
  });

  it("sync moves <ws>/.git to state/<id>.git with the same HEAD, history and remote-tracking ref; doctor warns before and is ok after", () => {
    toOldLayout();
    const before = { head: oldGit("rev-parse", "HEAD"), log: oldGit("log", "--format=%H %s"), tracking: oldGit("rev-parse", `refs/remotes/origin/${STATE_BRANCH}`) };
    const d1 = JSON.parse(run(home, proj, ["doctor", "--json"]).stdout);
    expect(d1.find((c) => c.check === "state repo outside the workspace")).toMatchObject({ level: "warn" });
    expect(d1.find((c) => c.check === "state repo outside the workspace").detail).toMatch(/moves to .*state\/.*\.git at the next sync or restore/);
    expect(existsSync(join(workspaceDir(home, id), ".git"))).toBe(true); // doctor never migrates
    const s = run(home, proj, ["sync"]);
    ok(s);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: true, committed: false });
    expect(existsSync(join(workspaceDir(home, id), ".git"))).toBe(false);
    expect(sgit(home, id, "rev-parse", "HEAD")).toBe(before.head);
    expect(sgit(home, id, "log", "--format=%H %s")).toBe(before.log);
    expect(sgit(home, id, "rev-parse", `refs/remotes/origin/${STATE_BRANCH}`)).toBe(before.tracking);
    expect(sgit(home, id, "status", "--porcelain")).toBe("");
    const d2 = JSON.parse(run(home, proj, ["doctor", "--json"]).stdout);
    expect(d2.find((c) => c.check === "state repo outside the workspace")).toMatchObject({ level: "ok" });
  });

  it("hooks on the migrated workspace: dirty with a remote, SessionStart reports unsynced state and Stop blocks; synced, both quiet", () => {
    const env = envFor(home);
    ok(run(home, proj, ["write", "-"], draft("demo:m-hooks")));
    expect(sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext).toMatch(/Workspace has unsynced state \(1 changed file\(s\), 0 unpushed commit\(s\)\)/);
    expect(stop({ cwd: proj }, { env })).toMatchObject({ decision: "block" });
    ok(run(home, proj, ["sync"]));
    expect(sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext).not.toMatch(/unsynced state/);
    expect(stop({ cwd: proj }, { env })).toBe(null);
  });

  it("an old git dir planted with commondir, config.worktree, alternates, info/attributes and hooks is rebuilt without them: same HEAD and history, no payload ran", () => {
    toOldLayout();
    const legacy = join(workspaceDir(home, id), ".git");
    const before = { head: oldGit("rev-parse", "HEAD"), log: oldGit("log", "--format=%H %s"), tracking: oldGit("rev-parse", `refs/remotes/origin/${STATE_BRANCH}`) };
    const junk = join(T, "junk-common");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "config"), `[filter "localevil"]\n\tclean = ${payload("legacy-commondir")}\n`);
    writeFileSync(join(legacy, "commondir"), `${junk}\n`);
    git(T, "config", "--file", join(legacy, "config"), "extensions.worktreeConfig", "true");
    writeFileSync(join(legacy, "config.worktree"), `[filter "localevil"]\n\tclean = ${payload("legacy-worktree-config")}\n`);
    mkdirSync(join(legacy, "info"), { recursive: true });
    writeFileSync(join(legacy, "info/attributes"), "* filter=localevil\n");
    mkdirSync(join(legacy, "objects/info"), { recursive: true });
    writeFileSync(join(legacy, "objects/info/alternates"), `${join(T, "nowhere")}\n`);
    mkdirSync(join(legacy, "hooks"), { recursive: true });
    writeFileSync(join(legacy, "hooks/post-commit"), `#!/bin/sh\ntouch ${M}/legacy-hook\n`, { mode: 0o755 });
    ok(run(home, proj, ["write", "-"], draft("demo:m-poisoned")));
    const s = run(home, proj, ["sync"]);
    ok(s);
    expect(JSON.parse(s.stdout)).toMatchObject({ ok: true, committed: true, pushed: true });
    expect(existsSync(legacy)).toBe(false);
    for (const e of ["commondir", "config.worktree", "info/attributes", "objects/info/alternates", "hooks"]) expect(existsSync(join(stateGitDir(home, id), e)), e).toBe(false);
    expect(sh(T, "git", ["config", "--file", join(stateGitDir(home, id), "config"), "--get", "extensions.worktreeconfig"]).status).not.toBe(0);
    expect(sgit(home, id, "log", "--format=%H %s", "--skip=1")).toBe(before.log); // the history, then the new commit on top
    expect(sgit(home, id, "rev-parse", "HEAD~1")).toBe(before.head);
    expect(markers()).toEqual([]);
  });

  it("restore of a workspace already here migrates it the same way", () => {
    toOldLayout();
    const head = oldGit("rev-parse", "HEAD");
    const r = run(home, proj, ["restore"]);
    ok(r);
    expect(JSON.parse(r.stdout)).toMatchObject({ id, restored: false });
    expect(existsSync(join(workspaceDir(home, id), ".git"))).toBe(false);
    expect(sgit(home, id, "rev-parse", "HEAD")).toBe(head);
  });

  it("two git dirs (old and new) are refused with exit 2 and nothing moves", () => {
    cpSync(stateGitDir(home, id), join(workspaceDir(home, id), ".git"), { recursive: true });
    const s = run(home, proj, ["sync"]);
    expect(s.status).toBe(2);
    expect(s.stderr).toMatch(/state repo refused: .*\.git/);
    expect(existsSync(join(workspaceDir(home, id), ".git"))).toBe(true);
    expect(existsSync(stateGitDir(home, id))).toBe(true);
    const d = JSON.parse(run(home, proj, ["doctor", "--json"]).stdout);
    expect(d.find((c) => c.check === "state repo outside the workspace")).toMatchObject({ level: "fail" });
    rmSync(join(workspaceDir(home, id), ".git"), { recursive: true, force: true });
    ok(run(home, proj, ["sync"]));
  });
});

describe("planted git attributes and config are refused before any git runs", () => {
  let p;
  let home;
  let proj;
  let id;
  let ws;
  let gd;
  let homeQ;
  let projQ;
  const gconf = (file, ...kv) => git(T, "config", "--file", file, ...kv);

  beforeAll(() => {
    p = project("p3");
    home = mkHome("x3");
    proj = p.clone("p3-x");
    const init = run(home, proj, ["init"]);
    ok(init);
    id = JSON.parse(init.stdout).id;
    ws = workspaceDir(home, id);
    gd = stateGitDir(home, id);
    ok(run(home, proj, ["write", "-"], draft("demo:x0")));
    ok(run(home, proj, ["sync"]));
    // A second machine that pushes records, so the next sync of the first one merges (the merge
    // driver case needs a real merge of the union files).
    homeQ = mkHome("q3");
    projQ = p.clone("p3-q");
    ok(run(homeQ, projQ, ["restore"]));
    // The user's own global config (legitimate, like git-lfs): a filter the planted attributes name,
    // and a global attributes file that maps *.md to a filter only a planted local config defines.
    const globalAttrs = join(home, "..", "global-attributes");
    writeFileSync(globalAttrs, "*.md filter=localevil\n");
    const gc = join(home, "..", ".gitconfig");
    gconf(gc, "filter.evil.clean", payload("global-filter"));
    gconf(gc, "core.attributesFile", globalAttrs);
  });

  const hooksDir = () => {
    const d = join(T, "planted-hooks");
    mkdirSync(d, { recursive: true });
    for (const h of ["pre-commit", "post-commit", "post-merge", "pre-push"]) writeFileSync(join(d, h), `#!/bin/sh\ntouch ${M}/hook-${h}\n`, { mode: 0o755 });
    return d;
  };
  const cases = [
    ["root .gitattributes", () => appendFileSync(join(ws, ".gitattributes"), "* filter=evil\n"), () => writeFileSync(join(ws, ".gitattributes"), TEMPLATE), /\.gitattributes differs from the kit template/],
    ["nested .gitattributes", () => writeFileSync(join(ws, "topics/.gitattributes"), "* filter=evil\n"), () => rmSync(join(ws, "topics/.gitattributes")), /topics\/\.gitattributes/],
    ["a .gitmodules", () => writeFileSync(join(ws, ".gitmodules"), `[submodule "x"]\n\tpath = x\n\turl = ./x\n\tupdate = !sh -c 'touch ${M}/gitmodules'\n`), () => rmSync(join(ws, ".gitmodules")), /\.gitmodules/],
    ["info/attributes", () => (mkdirSync(join(gd, "info"), { recursive: true }), writeFileSync(join(gd, "info/attributes"), "* filter=evil\n")), () => rmSync(join(gd, "info/attributes")), /info\/attributes/],
    ["config filter.*", () => gconf(join(gd, "config"), "filter.localevil.clean", payload("config-filter")), () => gconf(join(gd, "config"), "--remove-section", "filter.localevil"), /config sets filter\.localevil\.clean/],
    ["config diff.*.textconv", () => gconf(join(gd, "config"), "diff.localevil.textconv", payload("textconv")), () => gconf(join(gd, "config"), "--remove-section", "diff.localevil"), /config sets diff\.localevil\.textconv/],
    ["config merge.*.driver", () => gconf(join(gd, "config"), "merge.union.driver", `sh -c 'touch ${M}/merge-driver'`), () => gconf(join(gd, "config"), "--remove-section", "merge.union"), /config sets merge\.union\.driver/],
    ["config core.hooksPath", () => gconf(join(gd, "config"), "core.hooksPath", hooksDir()), () => gconf(join(gd, "config"), "--unset", "core.hooksPath"), /config sets core\.hookspath/],
    ["config core.fsmonitor", () => gconf(join(gd, "config"), "core.fsmonitor", `sh -c 'touch ${M}/fsmonitor'`), () => gconf(join(gd, "config"), "--unset", "core.fsmonitor"), /config sets core\.fsmonitor/],
    [
      "git dir commondir",
      () => {
        const other = join(T, "evil-common");
        rmSync(other, { recursive: true, force: true });
        cpSync(gd, other, { recursive: true });
        gconf(join(other, "config"), "filter.localevil.clean", payload("commondir"));
        writeFileSync(join(gd, "commondir"), `${other}\n`);
      },
      () => rmSync(join(gd, "commondir")),
      /commondir in the state git dir/,
    ],
    [
      "git dir config.worktree",
      () => {
        gconf(join(gd, "config"), "extensions.worktreeConfig", "true");
        writeFileSync(join(gd, "config.worktree"), `[filter "localevil"]\n\tclean = ${payload("config-worktree")}\n`);
      },
      () => (gconf(join(gd, "config"), "--unset", "extensions.worktreeConfig"), rmSync(join(gd, "config.worktree"))),
      /config\.worktree in the state git dir/,
    ],
    [
      "config include.path",
      () => {
        const inc = join(T, "included.conf");
        writeFileSync(inc, `[filter "localevil"]\n\tclean = ${payload("include")}\n`);
        gconf(join(gd, "config"), "include.path", inc);
      },
      () => gconf(join(gd, "config"), "--unset", "include.path"),
      /config sets include\.path/,
    ],
  ];

  it.each(cases)("%s: sync exits 2 naming it, doctor fails, the Stop hook blocks, and no payload ran", (name, plant, unplant, cause) => {
    const slug = name.split(/[^A-Za-z0-9]+/).join("-").toLowerCase(); // a claim_id is lowercase, no spaces
    ok(run(homeQ, projQ, ["write", "-"], draft(`demo:q-${slug}`)));
    ok(run(homeQ, projQ, ["sync"])); // the remote moves on: the planted side's sync would merge
    ok(run(home, proj, ["write", "-"], draft(`demo:x-${slug}`)));
    appendFileSync(join(ws, "index.md"), `\n<!-- ${name} -->\n`); // a dirty *.md: a filter on it would run at status/add
    plant();
    try {
      const s = run(home, proj, ["sync"]);
      expect(s.status, s.stdout).toBe(2);
      expect(s.stderr).toMatch(/loop-setup sync: state repo refused: /);
      expect(s.stderr).toMatch(cause);
      const d = run(home, proj, ["doctor", "--json"]);
      expect(d.status).toBe(1);
      const check = JSON.parse(d.stdout).find((c) => c.check === "state repo outside the workspace");
      expect(check.level).toBe("fail");
      expect(check.detail).toMatch(cause);
      const env = envFor(home);
      const blocked = stop({ cwd: proj }, { env });
      expect(blocked).toMatchObject({ decision: "block" });
      expect(blocked.reason).toMatch(cause);
      expect(sessionStart({ cwd: proj }, { env }).hookSpecificOutput.additionalContext).toMatch(/State repo refused: /);
      expect(markers()).toEqual([]);
    } finally {
      unplant();
    }
    const again = run(home, proj, ["sync"]);
    ok(again);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, pulled: "merged", pushed: true });
    expect(markers()).toEqual([]);
  });

  it("controls: the payloads are live — plain git without the guard runs them", () => {
    const ctl = join(T, "control");
    git(T, "clone", "-q", "--branch", STATE_BRANCH, p.remote, ctl);
    const env = envFor(home); // the same global config (the evil and localevil mappings)
    const plain = (...a) => sh(ctl, "git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], env);
    appendFileSync(join(ctl, ".gitattributes"), "* filter=evil\n");
    appendFileSync(join(ctl, "index.md"), "x\n");
    expect(plain("status", "--porcelain").status).toBe(0);
    expect(markers()).toContain("global-filter");
    git(ctl, "checkout", "--", ".gitattributes");
    gconf(join(ctl, ".git/config"), "filter.localevil.clean", payload("config-filter"));
    appendFileSync(join(ctl, "index.md"), "y\n");
    expect(plain("add", "-A").status).toBe(0);
    expect(markers()).toContain("config-filter");
    for (const m of markers()) rmSync(join(M, m));
  });
});

describe("planted content arriving from the remote state branch never reaches the work tree", () => {
  it("sync refuses to merge a fetched tree with a planted .gitattributes; restore refuses to check one out", () => {
    const p = project("p4");
    const home = mkHome("r4");
    const proj = p.clone("p4-r");
    const init = run(home, proj, ["init"]);
    ok(init);
    const id = JSON.parse(init.stdout).id;
    ok(run(home, proj, ["sync"]));
    git(T, "config", "--file", join(home, "..", ".gitconfig"), "filter.evil.clean", payload("incoming"));
    // Another clone of the state branch pushes a planted .gitattributes (plain git, no kit).
    const evil = join(T, "p4-evil");
    git(T, "clone", "-q", "--branch", STATE_BRANCH, p.remote, evil);
    appendFileSync(join(evil, ".gitattributes"), "* filter=evil\n");
    git(evil, "commit", "-qam", "planted");
    git(evil, "push", "-q", "origin", `HEAD:${STATE_BRANCH}`);

    const head = sgit(home, id, "rev-parse", "HEAD");
    ok(run(home, proj, ["write", "-"], draft("demo:r1")));
    const s = run(home, proj, ["sync"]);
    expect(s.status, s.stdout).toBe(2);
    expect(s.stderr).toMatch(/state repo refused: the fetched claude\/loop-state: \.gitattributes differs from the kit template/);
    expect(readFileSync(join(workspaceDir(home, id), ".gitattributes"), "utf8")).toBe(TEMPLATE);
    expect(sgit(home, id, "rev-parse", "HEAD")).not.toBe(""); // the local commit stays; nothing merged
    expect(sgit(home, id, "merge-base", "--is-ancestor", head, "HEAD")).toBe("");
    expect(sgit(home, id, "log", "--format=%s", "-1")).not.toBe("planted");

    const homeF = mkHome("f4");
    const projF = p.clone("p4-f");
    const r = run(homeF, projF, ["restore"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/state repo refused: the cloned claude\/loop-state: \.gitattributes differs from the kit template/);
    expect(existsSync(workspaceDir(homeF, id))).toBe(false);
    expect(existsSync(stateRoot(homeF)) ? readdirSync(stateRoot(homeF)) : []).toEqual([]);
    expect(markers()).toEqual([]);
  });
});
