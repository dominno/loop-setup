import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_NAME, STATE_BRANCH, isValidId, loopHome, resolveLayout, statePaths, workspaceDir } from "./layout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

// Evidence refs written before the kit left the project tree. reaudit compares a record's cited
// file at the record's commit against where that file lives now: a moved file against its kit path
// (a file-level map built from the kit move's renames, ec6d24b), legacy state against the workspace,
// and a file that was split in two is not compared at all — the record is told to re-verify.
describe("legacy evidence refs: one pure resolution for every path an old record cites", () => {
  it("normalizeRefPath makes an absolute path under the project or a legacy root repo-relative, and leaves other paths alone", async () => {
    const { normalizeRefPath } = await import("./layout.mjs");
    expect(normalizeRefPath("/home/user/loop-setup/scripts/trace/lib.mjs")).toBe("scripts/trace/lib.mjs");
    expect(normalizeRefPath("/tmp/clone/src/a.ts", ["/tmp/clone"])).toBe("src/a.ts");
    expect(normalizeRefPath("/tmp/clone/src/a.ts", ["/tmp/clone/"])).toBe("src/a.ts");
    expect(normalizeRefPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRefPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRefPath("/etc/hosts")).toBe("/etc/hosts");
    expect(normalizeRefPath("/home/user/loop-setupX/a.ts")).toBe("/home/user/loop-setupX/a.ts");
  });

  it("resolveLegacyRef gives each path exactly one kind: unchanged, moved, workspace, split or unmapped", async () => {
    const { resolveLegacyRef } = await import("./layout.mjs");
    expect(resolveLegacyRef("src/app/page.tsx")).toEqual({ kind: "unchanged", path: "src/app/page.tsx", target: { root: "project", path: "src/app/page.tsx" } });
    expect(resolveLegacyRef("scripts/trace/lib.mjs")).toEqual({ kind: "moved", path: "scripts/trace/lib.mjs", target: { root: "project", path: "kit/trace/lib.mjs" } });
    expect(resolveLegacyRef("/home/user/loop-setup/.claude/commands/dream.md")).toEqual({ kind: "moved", path: ".claude/commands/dream.md", target: { root: "project", path: "kit/commands/dream.md" } });
    expect(resolveLegacyRef(".claude/memory/topics/workflow.md")).toEqual({ kind: "workspace", path: ".claude/memory/topics/workflow.md", target: { root: "workspace", path: "topics/workflow.md" } });
    expect(resolveLegacyRef("CLAUDE.md")).toMatchObject({ kind: "split", path: "CLAUDE.md", at: "4ccf257", into: [{ root: "project", path: "CLAUDE.md" }, { root: "project", path: "kit/rules/KIT.md" }] });
    expect(resolveLegacyRef("/home/user/loop-setup/.claude/memory/topics/trace.md")).toMatchObject({ kind: "split", path: ".claude/memory/topics/trace.md", at: "ec6d24b", into: [{ root: "workspace", path: "topics/trace.md" }, { root: "project", path: "kit/rules/trace-policy.md" }] });
    expect(resolveLegacyRef(".claude/memory/loop-plan.md")).toMatchObject({ kind: "split", at: "9654bfb", into: [{ root: "workspace", path: "loop-plan.md" }, { root: "project", path: "kit/templates/workspace/loop-plan.md" }] });
    // A file under a directory the move emptied, with no rename of its own, and an absolute path outside every root.
    expect(resolveLegacyRef(".claude/workflows/gone.js")).toMatchObject({ kind: "unmapped", path: ".claude/workflows/gone.js" });
    expect(resolveLegacyRef("/etc/hosts")).toMatchObject({ kind: "unmapped", path: "/etc/hosts" });
    // Near misses of the map stay unchanged: a sibling directory, a project script that never moved.
    expect(resolveLegacyRef(".claude/workflowsX/a.js").kind).toBe("unchanged");
    expect(resolveLegacyRef("scripts/check-bundle-size.mjs").kind).toBe("unchanged");
  });

  it("evidenceHome tells a record older than a split to re-verify, and compares a newer one with the file's post-split home", async () => {
    const { evidenceHome } = await import("./layout.mjs");
    expect(evidenceHome("CLAUDE.md", { predates: () => true })).toEqual({ path: "CLAUDE.md", split: "4ccf257" });
    expect(evidenceHome("CLAUDE.md", { predates: () => false })).toEqual({ path: "CLAUDE.md", target: { root: "project", path: "CLAUDE.md" } });
    expect(evidenceHome("/home/user/loop-setup/.claude/memory/topics/trace.md", { predates: (at) => at === "ec6d24b" })).toEqual({ path: ".claude/memory/topics/trace.md", split: "ec6d24b" });
    expect(evidenceHome(".claude/memory/topics/trace.md", { predates: () => false })).toEqual({ path: ".claude/memory/topics/trace.md", target: { root: "workspace", path: "topics/trace.md" } });
    expect(evidenceHome("scripts/trace/lib.mjs")).toEqual({ path: "scripts/trace/lib.mjs", target: { root: "project", path: "kit/trace/lib.mjs" } });
    expect(evidenceHome(".claude/workflows/gone.js")).toEqual({ path: ".claude/workflows/gone.js", target: null });
    // The order cannot be known (the split commit is not in the repository): counts as older, re-verify.
    expect(evidenceHome("CLAUDE.md", { predates: () => null })).toEqual({ path: "CLAUDE.md", split: "4ccf257" });
    expect(evidenceHome(".claude/memory/topics/trace.md", { predates: () => null })).toEqual({ path: ".claude/memory/topics/trace.md", split: "ec6d24b" });
  });

  // Golden: every distinct path the frozen pre-move store cites, as reaudit reads it, and its kind.
  // A new legacy path in the fixture, or a mapping change, shows up here; zero may stay unmapped.
  it("every path the legacy-v1 fixture store cites resolves to exactly one kind, and none is unmapped", async () => {
    const { resolveLegacyRef } = await import("./layout.mjs");
    const { evidencePaths } = await import("../trace/lib.mjs");
    const store = readFileSync(join(ROOT, "kit/test/fixtures/legacy-v1/trace/records.jsonl"), "utf8");
    const records = store.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "record");
    const paths = [...new Set(records.flatMap((r) => [...evidencePaths(r)]))].sort();
    const moved = "moved", unchanged = "unchanged", workspace = "workspace", split = "split";
    const GOLDEN = {
      ".claude/commands/bench-checkers.md": moved, ".claude/commands/critic-round.md": moved, ".claude/commands/dream.md": moved,
      ".claude/commands/scan-project-docs.md": moved, ".claude/commands/sync-story-status.md": moved,
      ".claude/loop-checklist.md": moved, ".claude/loop.md": moved,
      ".claude/memory/topics/trace.md": split, ".claude/memory/topics/workflow.md": workspace, ".claude/memory/trace/records.jsonl": workspace,
      ".claude/trace/bench/README.md": moved, ".claude/trace/schema-v1.json": moved,
      ".claude/workflows/critic-panel.js": moved, ".claude/workflows/e2e-design.js": moved, ".claude/workflows/gap-analysis.js": moved,
      ".claude/workflows/improve-skills.js": moved, ".claude/workflows/loop-iteration.js": moved, ".claude/workflows/scan-docs.js": moved,
      ".claude/workflows/trace-bench.js": moved,
      "/home/user/loop-setup/.claude/commands/dream.md": moved, "/home/user/loop-setup/.claude/memory/topics/trace.md": split,
      "/home/user/loop-setup/scripts/trace/bench-judge.mjs": moved, "/home/user/loop-setup/scripts/trace/contracts.test.mjs": moved,
      "/home/user/loop-setup/scripts/trace/lib.mjs": moved, "/home/user/loop-setup/scripts/trace/wiki.test.mjs": moved,
      "docs/stories/US-001-greeting.md": unchanged, "docs/workflow-graphs.md": moved, "e2e/smoke.spec.ts": unchanged,
      "node_modules/.pnpm/playwright@1.56.0/.../webServerPlugin.js": unchanged, "node_modules/next/dist/server/config.js": unchanged,
      "package.json": unchanged, "playwright.config.ts": unchanged, "scripts/template-docs.test.mjs": unchanged,
      "scripts/trace/bench-judge.mjs": moved, "scripts/trace/cli.mjs": moved, "scripts/trace/cli.test.mjs": moved,
      "scripts/trace/config.test.mjs": moved, "scripts/trace/contracts.test.mjs": moved, "scripts/trace/lib.mjs": moved,
      "scripts/trace/lib.test.mjs": moved, "scripts/trace/plan.mjs": moved, "scripts/trace/story-map.mjs": moved,
      "scripts/trace/wiki.test.mjs": moved, "scripts/trace/workflows.test.mjs": moved,
    };
    const kinds = Object.fromEntries(paths.map((p) => [p, resolveLegacyRef(p).kind]));
    expect(kinds).toEqual(GOLDEN);
    expect(paths.filter((p) => resolveLegacyRef(p).kind === "unmapped")).toEqual([]);
  });
});

// The map and the splits are facts about this repository's history, checked against it. These tests
// read git history, so they need a full clone (CI's checks job fetches it).
describe("legacy evidence refs against the repository's history", () => {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const fullHistory = () => expect(git("rev-parse", "--is-shallow-repository").trim(), "these tests need full git history (git fetch --unshallow)").toBe("false");

  it("LEGACY_REF_MAP is exactly the kit move's renames from outside kit/ into kit/ (git diff -M --name-status of the move commit)", async () => {
    fullHistory();
    const { LEGACY_MOVE_COMMIT, LEGACY_REF_MAP } = await import("./layout.mjs");
    const renames = git("diff", "-M", "--name-status", `${LEGACY_MOVE_COMMIT}^`, LEGACY_MOVE_COMMIT)
      .split("\n").map((l) => l.split("\t"))
      .filter(([status, from, to]) => /^R/.test(status) && !from.startsWith("kit/") && to?.startsWith("kit/"))
      .map(([, from, to]) => [from, to]);
    expect(renames.length).toBeGreaterThan(0);
    const byPath = (a, b) => a[0].localeCompare(b[0]);
    expect([...LEGACY_REF_MAP].sort(byPath)).toEqual(renames.sort(byPath));
  });

  it("the move left every vacated directory empty, and each split commit added the kit half of its file", async () => {
    fullHistory();
    const { LEGACY_MOVE_COMMIT, LEGACY_SPLITS, LEGACY_VACATED_DIRS } = await import("./layout.mjs");
    for (const dir of LEGACY_VACATED_DIRS) expect(git("ls-tree", "-r", "--name-only", LEGACY_MOVE_COMMIT, "--", dir).trim(), dir).toBe("");
    for (const s of LEGACY_SPLITS) {
      const kitHalf = s.into.find((t) => t.root === "project" && t.path.startsWith("kit/"));
      expect(git("show", "--name-status", "--format=", s.at, "--", kitHalf.path).trim(), `${s.from} at ${s.at}`).toBe(`A\t${kitHalf.path}`);
    }
  });
});
