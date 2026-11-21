// Integration tests of the facts adapter against REAL git repositories, worktrees and symlinks
// (no mocks): what resolveLayout decides depends on what git and the filesystem actually say.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentLayout, gatherFacts } from "./facts.mjs";
import { workspaceDir } from "./layout.mjs";

let d;
let home;
let repo;
const git = (cwd, ...a) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" });
const env = (over = {}) => ({ CLAUDE_CONFIG_DIR: home, ...over });

beforeEach(() => {
  d = realpathSync(mkdtempSync(join(tmpdir(), "ls-facts-")));
  home = join(d, "home/.claude");
  repo = join(d, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

describe("gatherFacts / currentLayout (real git)", () => {
  it("a plain repo with nothing set up is NO_WORKSPACE, rooted at the git toplevel", () => {
    mkdirSync(join(repo, "sub"));
    const f = gatherFacts({ cwd: join(repo, "sub"), env: env() });
    expect(f.projectRoot).toBe(repo);
    expect(f.claudeHome).toBe(home);
    expect(f.inWorktree).toBe(false);
    expect(currentLayout({ cwd: join(repo, "sub"), env: env() })).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
  });

  it("outside any repository the project root is null", () => {
    const out = join(d, "out");
    mkdirSync(out);
    expect(gatherFacts({ cwd: out, env: env() }).projectRoot).toBe(null);
  });

  it("the clone marker binds; a linked worktree resolves the same workspace through the shared config", () => {
    const ws = workspaceDir(home, "app-1a2b3c4d");
    mkdirSync(ws, { recursive: true });
    git(repo, "config", "--local", "loop-setup.workspace", "app-1a2b3c4d");
    mkdirSync(join(repo, ".claude"));
    symlinkSync(ws, join(repo, ".claude/loop-workspace"));
    expect(currentLayout({ cwd: repo, env: env() })).toMatchObject({ ok: true, mode: "bound", workspace: ws, warnings: [] });

    const wt = join(d, "wt");
    git(repo, "worktree", "add", "-q", wt);
    const inWt = currentLayout({ cwd: wt, env: env() });
    expect(inWt).toMatchObject({ ok: true, mode: "bound", workspace: ws, inWorktree: true, projectRoot: wt });
  });

  it("a marker whose workspace is gone is MISSING_WORKSPACE", () => {
    git(repo, "config", "--local", "loop-setup.workspace", "app-1a2b3c4d");
    expect(currentLayout({ cwd: repo, env: env() })).toMatchObject({ ok: false, code: "MISSING_WORKSPACE" });
  });

  it("a real directory at the link path does not bind; the legacy .claude/memory does", () => {
    mkdirSync(join(repo, ".claude/loop-workspace"), { recursive: true });
    expect(currentLayout({ cwd: repo, env: env() })).toMatchObject({ ok: false, code: "NO_WORKSPACE", warnings: ["link-not-symlink"] });
    mkdirSync(join(repo, ".claude/memory/trace"), { recursive: true });
    writeFileSync(join(repo, ".claude/memory/trace/records.jsonl"), "");
    expect(currentLayout({ cwd: repo, env: env() })).toMatchObject({ ok: true, mode: "legacy", workspace: join(repo, ".claude/memory") });
  });

  it("LOOP_SETUP_WORKSPACE is taken as given (resolved against the cwd) and must exist", () => {
    mkdirSync(join(repo, "fx"));
    expect(currentLayout({ cwd: repo, env: env({ LOOP_SETUP_WORKSPACE: "fx" }) })).toMatchObject({ ok: true, mode: "env", workspace: join(repo, "fx") });
    expect(currentLayout({ cwd: repo, env: env({ LOOP_SETUP_WORKSPACE: "missing" }) })).toMatchObject({ ok: false, code: "ENV_WORKSPACE_MISSING" });
  });

  it("without CLAUDE_CONFIG_DIR the home is <HOME>/.claude", () => {
    expect(gatherFacts({ cwd: repo, env: { HOME: join(d, "h2") } }).claudeHome).toBe(join(d, "h2/.claude"));
  });
});
