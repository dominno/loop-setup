import { describe, expect, it } from "vitest";
import { LINK_NAME, STATE_BRANCH, isValidId, loopHome, resolveLayout, statePaths, workspaceDir } from "./layout.mjs";

// The pure core: every branch of the resolver is decided from facts alone (no fs, git, env).
const HOME = "/home/u/.claude";
const LH = `${HOME}/loop-setup`;
const base = {
  claudeHome: HOME,
  kitRoot: "/kit",
  projectRoot: "/repo",
  inWorktree: false,
  envWorkspace: null,
  marker: null,
  link: { kind: "missing", realpath: null },
  legacy: false,
};
const facts = (over) => ({ ...base, ...over });

describe("layout constants", () => {
  it("names the link, the state branch and the home layout", () => {
    expect(LINK_NAME).toBe(".claude/loop-workspace");
    expect(STATE_BRANCH).toBe("claude/loop-state");
    expect(loopHome(HOME)).toBe(LH);
    expect(workspaceDir(HOME, "app-1a2b3c4d")).toBe(`${LH}/workspaces/app-1a2b3c4d`);
  });

  it("accepts only lowercase slug ids (no path tricks)", () => {
    for (const ok of ["loop-setup-3f9a1c2e", "a", "app2"]) expect(isValidId(ok), ok).toBe(true);
    for (const bad of ["", "../x", "A-b", "a/b", "-a", "a b", "x".repeat(80), null, 7]) expect(isValidId(bad), String(bad)).toBe(false);
  });

  it("joins the state paths under a workspace", () => {
    const p = statePaths("/ws");
    expect(p.store).toBe("/ws/trace/records.jsonl");
    expect(p.plan).toBe("/ws/loop-plan.md");
    expect(p.runLog).toBe("/ws/loop-run-log.md");
    expect(p.index).toBe("/ws/index.md");
    expect(p.topics).toBe("/ws/topics");
  });
});

describe("resolveLayout", () => {
  it("an explicit LOOP_SETUP_WORKSPACE wins when it exists", () => {
    const r = resolveLayout(facts({ envWorkspace: { path: "/tmp/ws", exists: true }, marker: { id: "app-1", exists: true } }));
    expect(r).toMatchObject({ ok: true, mode: "env", workspace: "/tmp/ws", projectRoot: "/repo", kitRoot: "/kit" });
  });

  it("an explicit LOOP_SETUP_WORKSPACE that does not exist is an error, never silently ignored", () => {
    const r = resolveLayout(facts({ envWorkspace: { path: "/nope", exists: false }, legacy: true }));
    expect(r).toMatchObject({ ok: false, code: "ENV_WORKSPACE_MISSING" });
  });

  it("the clone marker binds the workspace under the home", () => {
    const ws = workspaceDir(HOME, "app-1");
    const r = resolveLayout(facts({ marker: { id: "app-1", exists: true }, link: { kind: "symlink", realpath: ws } }));
    expect(r).toMatchObject({ ok: true, mode: "bound", workspace: ws, workspaceId: "app-1", warnings: [] });
  });

  it("a bound workspace warns when the link is missing, stale or not a symlink", () => {
    const m = { id: "app-1", exists: true };
    expect(resolveLayout(facts({ marker: m })).warnings).toEqual(["link-missing"]);
    expect(resolveLayout(facts({ marker: m, link: { kind: "symlink", realpath: "/elsewhere" } })).warnings).toEqual(["link-stale"]);
    expect(resolveLayout(facts({ marker: m, link: { kind: "other", realpath: null } })).warnings).toEqual(["link-not-symlink"]);
  });

  it("a worktree is bound through the shared marker and never needs the link", () => {
    const r = resolveLayout(facts({ inWorktree: true, marker: { id: "app-1", exists: true } }));
    expect(r).toMatchObject({ ok: true, mode: "bound", inWorktree: true, warnings: [] });
  });

  it("a marker whose workspace is missing asks for restore", () => {
    const r = resolveLayout(facts({ marker: { id: "app-1", exists: false } }));
    expect(r).toMatchObject({ ok: false, code: "MISSING_WORKSPACE", workspaceId: "app-1" });
    expect(r.hint).toMatch(/loop-setup restore/);
  });

  it("a malformed marker fails closed", () => {
    expect(resolveLayout(facts({ marker: { id: "../../etc", exists: true } }))).toMatchObject({ ok: false, code: "BAD_MARKER" });
  });

  it("without a marker, only a symlink into this home's workspaces binds", () => {
    const ws = workspaceDir(HOME, "app-9");
    expect(resolveLayout(facts({ link: { kind: "symlink", realpath: ws } }))).toMatchObject({ ok: true, mode: "link", workspace: ws, workspaceId: "app-9" });
    const foreign = resolveLayout(facts({ link: { kind: "symlink", realpath: "/tmp/evil" } }));
    expect(foreign).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
    expect(foreign.warnings).toContain("link-foreign");
    const nested = resolveLayout(facts({ link: { kind: "symlink", realpath: `${LH}/workspaces/app-9/topics` } }));
    expect(nested.ok).toBe(false);
  });

  it("a real directory at the link path never binds (repo-authored content)", () => {
    const r = resolveLayout(facts({ link: { kind: "other", realpath: null } }));
    expect(r).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
    expect(r.warnings).toContain("link-not-symlink");
  });

  it("falls back to the legacy in-repo .claude/memory", () => {
    expect(resolveLayout(facts({ legacy: true }))).toMatchObject({ ok: true, mode: "legacy", workspace: "/repo/.claude/memory" });
  });

  it("nothing found is NO_WORKSPACE with an init/restore hint", () => {
    const r = resolveLayout(facts({}));
    expect(r).toMatchObject({ ok: false, code: "NO_WORKSPACE" });
    expect(r.hint).toMatch(/loop-setup init/);
    expect(r.hint).toMatch(/loop-setup restore/);
  });

  it("outside a git repository there is no project (unless the workspace is explicit)", () => {
    expect(resolveLayout(facts({ projectRoot: null }))).toMatchObject({ ok: false, code: "NO_REPO" });
    expect(resolveLayout(facts({ projectRoot: null, envWorkspace: { path: "/ws", exists: true } }))).toMatchObject({ ok: true, mode: "env", projectRoot: null });
  });
});

describe("legacyTarget (evidence refs written before the kit moved out of the repo)", () => {
  it("maps moved machinery to its kit path and legacy state to the workspace", async () => {
    const { legacyTarget } = await import("./layout.mjs");
    expect(legacyTarget("scripts/trace/lib.mjs")).toEqual({ root: "project", path: "kit/trace/lib.mjs" });
    expect(legacyTarget(".claude/workflows/loop-iteration.js")).toEqual({ root: "project", path: "kit/workflows/loop-iteration.js" });
    expect(legacyTarget(".claude/commands/dream.md")).toEqual({ root: "project", path: "kit/commands/dream.md" });
    expect(legacyTarget(".claude/loop.md")).toEqual({ root: "project", path: "kit/loop.md" });
    expect(legacyTarget(".claude/trace/schema-v1.json")).toEqual({ root: "project", path: "kit/schema/schema-v1.json" });
    expect(legacyTarget(".claude/trace/bench/README.md")).toEqual({ root: "project", path: "kit/bench/README.md" });
    expect(legacyTarget("scripts/hooks/stop-gate.test.mjs")).toEqual({ root: "project", path: "kit/hooks/stop-gate.test.mjs" });
    expect(legacyTarget("docs/planning-guide.md")).toEqual({ root: "project", path: "kit/docs/planning-guide.md" });
    expect(legacyTarget(".claude/memory/topics/trace.md")).toEqual({ root: "workspace", path: "topics/trace.md" });
  });

  it("leaves every other path alone", async () => {
    const { legacyTarget } = await import("./layout.mjs");
    for (const p of ["src/app/page.tsx", "docs/prd.md", ".claude/settings.json", "scripts/check-bundle-size.mjs", ".claude/workflowsX/a.js"]) expect(legacyTarget(p), p).toBe(null);
  });
});
