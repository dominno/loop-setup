// Installer hardening, on the real stack where it matters (a committed kit source, real installs into
// temp Claude homes, the CLI as a process, real symlinks) and directly on the pure decisions:
//   1. install/uninstall refuse the session's own Claude home under CLAUDECODE; owned deny rules
//   2. a settings.json that parses but is not an object is refused before any change
//   3. hook command paths are shell-safe (quoted, metacharacters rejected)
//   4. ensureLink repairs only links into this home's workspaces root
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { install, uninstall } from "./install.mjs";
import { lifecycleRefusal } from "./guard.mjs";
import { ownedSettings, shellArg, shimText } from "./kittree.mjs";
import { isWorkspacePath, workspaceDir, workspacesRoot } from "./layout.mjs";
import { ensureLink } from "./workspace.mjs";
import { sessionStart } from "./hooks.mjs";

const SLOW = 60_000;
const CLI = join(KIT_ROOT, "bin/loop-setup.mjs");
let T;
let kitSrc;
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
let homes = 0;
const mkHome = (name = `h${(homes += 1)}`) => {
  const h = join(T, name, ".claude");
  mkdirSync(h, { recursive: true });
  return h;
};
/** An environment as a Claude Code session's Bash sees it (CLAUDECODE=1), pointed at `home`. */
const sessionEnv = (home, extra = {}) => {
  const e = { ...process.env, CLAUDECODE: "1", CLAUDE_CONFIG_DIR: home, HOME: join(home, "..") };
  delete e.LOOP_SETUP_WORKSPACE;
  return { ...e, ...extra };
};
const humanEnv = (home) => {
  const e = sessionEnv(home);
  delete e.CLAUDECODE;
  return e;
};
const cli = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: T, encoding: "utf8", env });

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "ls-harden-")));
  kitSrc = join(T, "kitsrc");
  mkdirSync(kitSrc);
  cpSync(KIT_ROOT, join(kitSrc, "kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  git(kitSrc, "init", "-q");
  git(kitSrc, "add", "-A");
  git(kitSrc, "commit", "-qm", "kit");
}, SLOW);
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("1. lifecycle writes refuse the session's own Claude home under CLAUDECODE", () => {
  it("lifecycleRefusal (pure): refuses only when CLAUDECODE is set and the target is the session's home", () => {
    const home = "/h/.claude";
    expect(lifecycleRefusal({ cmd: "install", claudecode: undefined, targetHome: home, sessionHome: home })).toBe(null);
    expect(lifecycleRefusal({ cmd: "install", claudecode: "", targetHome: home, sessionHome: home })).toBe(null);
    expect(lifecycleRefusal({ cmd: "install", claudecode: "1", targetHome: "/tmp/scratch/.claude", sessionHome: home })).toBe(null);
    for (const cmd of ["install", "uninstall"]) {
      const why = lifecycleRefusal({ cmd, claudecode: "1", targetHome: home, sessionHome: home });
      expect(why).toMatch(new RegExp(`^loop-setup ${cmd} refused: .*this session's Claude home \\(/h/\\.claude\\).*CLAUDECODE is set`));
      expect(why).toMatch(/outside Claude Code/);
    }
  });

  it("install and uninstall (the functions) refuse the session's home, including through a symlink alias, and change nothing", () => {
    const home = mkHome();
    const alias = join(T, "alias-claude");
    symlinkSync(home, alias);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "x" }));
    for (const target of [home, alias]) {
      expect(() => install({ from: kitSrc, claudeHome: target, env: sessionEnv(home) })).toThrow(/refused: .*CLAUDECODE is set/);
    }
    expect(existsSync(join(home, "loop-setup"))).toBe(false);
    expect(existsSync(join(home, "commands"))).toBe(false);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(JSON.stringify({ model: "x" }));
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home) }); // a human, outside Claude Code
    expect(() => uninstall({ claudeHome: home, env: sessionEnv(home) })).toThrow(/loop-setup uninstall refused/);
    expect(existsSync(join(home, "loop-setup/kit/kit.json"))).toBe(true); // still installed
  }, SLOW);

  it("an install into a different Claude home than the session's (as the tests do) still works under CLAUDECODE", () => {
    const session = mkHome();
    const other = mkHome();
    const m = install({ from: kitSrc, claudeHome: other, env: sessionEnv(session) });
    expect(m.kit.name).toBe("loop-setup");
    expect(existsSync(join(other, "loop-setup/kit/kit.json"))).toBe(true);
  }, SLOW);

  it("the CLI exits 2 under CLAUDECODE for the session's home and installs/uninstalls for a human", () => {
    const home = mkHome();
    const refused = cli(sessionEnv(home), "install", "--from", kitSrc);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/loop-setup install refused: .*CLAUDECODE is set/);
    expect(existsSync(join(home, "loop-setup"))).toBe(false);
    expect(cli(humanEnv(home), "install", "--from", kitSrc).status).toBe(0);
    const keep = cli(sessionEnv(home), "uninstall");
    expect(keep.status).toBe(2);
    expect(keep.stderr).toMatch(/loop-setup uninstall refused/);
    expect(existsSync(join(home, "loop-setup/kit"))).toBe(true);
    expect(cli(humanEnv(home), "uninstall").status).toBe(0);
    expect(existsSync(join(home, "loop-setup/kit"))).toBe(false);
  }, SLOW);

  it("install adds owned user-scope deny rules for the lifecycle write subcommands and direct node runs; uninstall removes them", () => {
    const home = mkHome();
    const mine = { permissions: { deny: ["Bash(rm -rf /)"] } };
    writeFileSync(join(home, "settings.json"), JSON.stringify(mine));
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home) });
    const deny = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).permissions.deny;
    const lifecycle = ["install", "uninstall"].flatMap((c) => [`Bash(loop-setup ${c})`, `Bash(loop-setup ${c} *)`, `Bash(*/loop-setup ${c})`, `Bash(*/loop-setup ${c} *)`]);
    expect(deny).toEqual(expect.arrayContaining(["Bash(rm -rf /)", ...lifecycle, "Bash(node *loop-setup.mjs*)"]));
    uninstall({ claudeHome: home, env: humanEnv(home) });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual(mine);
  }, SLOW);
});

describe("2. a settings.json that parses but is not a plain object is refused before any change", () => {
  it.each([['"x"'], ["[]"], ["null"], ["42"]])("settings.json = %s: install refuses, nothing is written", (text) => {
    const home = mkHome();
    writeFileSync(join(home, "settings.json"), text);
    expect(() => install({ from: kitSrc, claudeHome: home, env: humanEnv(home) })).toThrow(/settings\.json parses but is not a JSON object .*loop-setup changed nothing/);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(text);
    expect(existsSync(join(home, "loop-setup"))).toBe(false);
    expect(existsSync(join(home, "commands"))).toBe(false);
  }, SLOW);

  it.each([['{"hooks":"x"}'], ['{"permissions":{"allow":"x"}}'], ['{"hooks":{"SessionStart":"x"}}']])("an object whose hooks or permissions have the wrong shape (%s): install refuses before any write", (text) => {
    const home = mkHome();
    writeFileSync(join(home, "settings.json"), text);
    expect(() => install({ from: kitSrc, claudeHome: home, env: humanEnv(home) })).toThrow(/settings\.json: its hooks or permissions have the wrong shape .*loop-setup changed nothing/);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(text);
    for (const p of ["loop-setup", "commands"]) expect(existsSync(join(home, p)), p).toBe(false);
  }, SLOW);

  it("uninstall over a wrongly shaped settings.json keeps the commands and the manifest", () => {
    const home = mkHome();
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home) });
    writeFileSync(join(home, "settings.json"), '{"permissions":{"deny":{}}}');
    expect(() => uninstall({ claudeHome: home, env: humanEnv(home) })).toThrow(/wrong shape/);
    expect(existsSync(join(home, "commands/dream.md"))).toBe(true);
    expect(existsSync(join(home, "loop-setup/installed.json"))).toBe(true);
  }, SLOW);

  it("uninstall refuses too, before removing anything", () => {
    const home = mkHome();
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home) });
    writeFileSync(join(home, "settings.json"), "[]");
    expect(() => uninstall({ claudeHome: home, env: humanEnv(home) })).toThrow(/not a JSON object/);
    expect(existsSync(join(home, "loop-setup/kit/kit.json"))).toBe(true);
  }, SLOW);
});

describe("3. hook command paths are shell-safe", () => {
  it("shellArg (pure): double quotes for a plain path, single quotes when it holds a double quote, metacharacters rejected", () => {
    expect(shellArg("/h/.claude/loop-setup/bin/loop-setup")).toBe('"/h/.claude/loop-setup/bin/loop-setup"');
    expect(shellArg("/home/my user/.claude")).toBe('"/home/my user/.claude"');
    expect(shellArg("/home/o'neil/.claude")).toBe(`"/home/o'neil/.claude"`);
    expect(shellArg('/home/a "b"/it\'s')).toBe(`'/home/a "b"/it'\\''s'`);
    for (const ch of ["$", "`", "\\", ";", "&", "|", "<", ">", "(", ")", "{", "}", "[", "]", "*", "?", "!", "\n", "\t"]) {
      expect(() => shellArg(`/home/a${ch}b/.claude`), JSON.stringify(ch)).toThrow(new RegExp(`shell metacharacter ${JSON.stringify(ch).replace(/[\\[\](){}*?$|^.]/g, "\\$&")}`));
    }
  });

  it("ownedSettings and shimText quote through shellArg and reject a metacharacter path", () => {
    const kitDir = '/h/a "q"/.claude/loop-setup/kit';
    const owned = ownedSettings({ kitDir, loopDir: '/h/a "q"/.claude/loop-setup', shim: '/h/a "q"/.claude/loop-setup/bin/loop-setup', nodePath: "/usr/bin/node", withStopGate: true });
    expect(owned.hooks.Stop[0].hooks[0].command).toBe(`'/h/a "q"/.claude/loop-setup/bin/loop-setup' hook stop`);
    expect(owned.hooks.Stop[1].hooks[0].command).toBe(`"/usr/bin/node" '/h/a "q"/.claude/loop-setup/kit/hooks/stop-gate.mjs'`);
    expect(shimText("/usr/bin/node", kitDir)).toBe(`#!/bin/sh\nexec "/usr/bin/node" '/h/a "q"/.claude/loop-setup/kit/bin/loop-setup.mjs' "$@"\n`);
    expect(() => ownedSettings({ kitDir: "/h/$(id)/kit", loopDir: "/h/$(id)", shim: "/h/$(id)/bin/loop-setup", nodePath: "/usr/bin/node" })).toThrow(/shell metacharacter "\$"/);
  });

  it("an install into a home whose path holds a space and both quote kinds: the hook commands and the shim run through sh", () => {
    const home = join(T, `it's a "home"`, ".claude");
    mkdirSync(home, { recursive: true });
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home), withStopGate: true });
    const s = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    for (const [event, groups] of Object.entries(s.hooks)) {
      for (const g of groups) {
        const cmd = g.hooks[0].command;
        if (cmd.includes("stop-gate")) continue; // the stop gate runs the project's checks; quoting is pinned above
        const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: T, encoding: "utf8", input: "{}", env: humanEnv(home) });
        expect(r.status, `${event}: ${cmd}\n${r.stderr}`).toBe(0);
        expect(r.stderr).not.toMatch(/not found|No such file|syntax error/);
      }
    }
    const where = spawnSync("/bin/sh", ["-c", `${shellArg(join(home, "loop-setup/bin/loop-setup"))} where --json`], { cwd: T, encoding: "utf8", env: humanEnv(home) });
    expect(JSON.parse(where.stdout)).toMatchObject({ code: "NO_REPO" }); // the shim ran the kit
  }, SLOW);

  it("the session-start hook's PATH line in CLAUDE_ENV_FILE stays one shell word for a home with a space and a double quote", () => {
    const home = join(T, `env "file" home`, ".claude");
    mkdirSync(home, { recursive: true });
    install({ from: kitSrc, claudeHome: home, env: humanEnv(home) });
    const proj = join(T, `p-env-${(homes += 1)}`);
    mkdirSync(proj, { recursive: true });
    git(proj, "init", "-q");
    const ws = join(T, `ws-env-${homes}`);
    mkdirSync(ws, { recursive: true });
    const envFile = join(T, `env-${homes}.sh`);
    writeFileSync(envFile, "");
    expect(sessionStart({ cwd: proj }, { env: { ...humanEnv(home), LOOP_SETUP_WORKSPACE: ws, CLAUDE_ENV_FILE: envFile } })).not.toBe(null);
    const r = spawnSync("/bin/sh", ["-c", '. "$1" && command -v loop-setup', "sh", envFile], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(r.status, r.stderr + readFileSync(envFile, "utf8")).toBe(0);
    expect(r.stdout.trim()).toBe(join(home, "loop-setup/bin/loop-setup"));
  }, SLOW);

  it("an install into a home whose path holds a shell metacharacter is refused before any change", () => {
    const home = join(T, "cash$home", ".claude");
    mkdirSync(home, { recursive: true });
    expect(() => install({ from: kitSrc, claudeHome: home, env: humanEnv(home) })).toThrow(/shell metacharacter "\$"/);
    expect(existsSync(join(home, "loop-setup"))).toBe(false);
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(existsSync(join(home, "commands"))).toBe(false);
  }, SLOW);
});

describe("4. ensureLink repairs only links into this home's workspaces root", () => {
  it("isWorkspacePath (pure): directly under workspacesRoot(claudeHome), with a valid id", () => {
    const home = "/h/.claude";
    const root = workspacesRoot(home);
    expect(isWorkspacePath(`${root}/proj-1a2b`, home)).toBe(true);
    expect(isWorkspacePath(`${root}/proj-1a2b/`, home)).toBe(true);
    expect(isWorkspacePath(`${root}/../workspaces/proj-1a2b`, home)).toBe(true); // lexically the same place
    for (const p of [`${root}/proj/sub`, `${root}/Proj`, root, `${root}/`, "/other/.claude/loop-setup/workspaces/proj-1a2b", "/tmp/loop-setup/workspaces/proj-1a2b", `${root}-evil/proj`, null, ""]) {
      expect(isWorkspacePath(p, home), String(p)).toBe(false);
    }
  });

  it("ensureLink replaces a stale link into this home's workspaces, and leaves a link into another home's workspaces alone", () => {
    const home = mkHome();
    const ws = workspaceDir(home, "proj-new");
    mkdirSync(ws, { recursive: true });
    const proj = join(T, `p-link-${(homes += 1)}`);
    mkdirSync(join(proj, ".claude"), { recursive: true });
    git(proj, "init", "-q");
    const lp = join(proj, ".claude/loop-workspace");

    symlinkSync(workspaceDir(home, "proj-old"), lp); // stale: restored under another id
    expect(ensureLink(proj, ws, home)).toMatchObject({ status: "created" });
    expect(readlinkSync(lp)).toBe(ws);

    for (const foreign of ["/tmp/elsewhere/.claude/loop-setup/workspaces/proj-old", "/srv/loop-setup/workspaces/x", "../../loop-setup/workspaces/x"]) {
      rmSync(lp);
      symlinkSync(foreign, lp);
      expect(ensureLink(proj, ws, home), foreign).toMatchObject({ status: "blocked: foreign link" });
      expect(lstatSync(lp).isSymbolicLink() && readlinkSync(lp)).toBe(foreign);
    }
    expect(dirname(ws)).toBe(workspacesRoot(home));
  });
});
