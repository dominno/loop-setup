// Loop-setup layout — the PURE core that decides where the kit, the project and the loop state live.
//
// Hexagonal rule: this module reads no filesystem, git, environment, clock or cwd. The facts
// (what is on disk, what git says) come from kit/setup/facts.mjs, the driven adapter; the CLI
// and the hooks are the driving adapters. node:path/posix is pure string handling.
import { posix } from "node:path";

const { basename, join } = posix;

/** The git-ignored link inside the project's REAL .claude/ directory (never .claude itself: worktrees need it real). */
export const LINK_NAME = ".claude/loop-workspace";
/** The legacy, in-repo state directory of a project that has not migrated. */
export const LEGACY_DIR = ".claude/memory";
/** The orphan branch of the project's own remote that carries the workspace between sessions. */
export const STATE_BRANCH = "claude/loop-state";
/** The clone marker: `git config --local loop-setup.workspace <id>`, shared by every worktree of the clone. */
export const MARKER_KEY = "loop-setup.workspace";

/** Paths of the loop state, relative to a workspace (the same names the legacy .claude/memory used). */
export const STATE_PATHS = {
  store: "trace/records.jsonl",
  plan: "loop-plan.md",
  runLog: "loop-run-log.md",
  index: "index.md",
  log: "log.md",
  quarantine: "quarantine.md",
  topics: "topics",
};

/** The kit's home under the Claude config dir (~/.claude, or $CLAUDE_CONFIG_DIR). */
export const loopHome = (claudeHome) => join(claudeHome, "loop-setup");
export const workspacesRoot = (claudeHome) => join(loopHome(claudeHome), "workspaces");
export const workspaceDir = (claudeHome, id) => join(workspacesRoot(claudeHome), id);

/** A workspace id: a lowercase slug, so it can never climb out of the workspaces root. */
export const isValidId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);

/** True when path (after lexical normalization) is a workspace directly under this home's workspaces root, with a valid id. */
export function isWorkspacePath(path, claudeHome) {
  if (typeof path !== "string" || !path) return false;
  const p = posix.normalize(path).replace(/\/+$/, "");
  return posix.dirname(p) === workspacesRoot(claudeHome) && isValidId(posix.basename(p));
}

/** The absolute state paths under a workspace. */
export function statePaths(workspace) {
  return Object.fromEntries(Object.entries(STATE_PATHS).map(([k, rel]) => [k, join(workspace, rel)]));
}

/**
 * Where a workspace's git directory lives (phase C, goal C3): beside the workspaces root, never inside
 * a workspace, so it is outside the per-project additionalDirectories grant and a write into the
 * workspace cannot plant git config, hooks or attributes git would read at sync time.
 */
export const stateRoot = (claudeHome) => join(loopHome(claudeHome), "state");
export function stateGitDir(claudeHome, id) {
  if (!isValidId(id)) throw new Error(`not a workspace id: ${id}`);
  return join(stateRoot(claudeHome), `${id}.git`);
}

/** The workspace id a state git dir is named by: the layout's, else that of a workspace directly under this home's workspaces root, else null. */
export function stateIdOf({ claudeHome, workspace, workspaceId = null }) {
  if (isValidId(workspaceId)) return workspaceId;
  return isWorkspacePath(workspace, claudeHome) ? basename(posix.normalize(workspace).replace(/\/+$/, "")) : null;
}

/**
 * Which git dir serves a workspace, from facts: outside = state/<id>.git exists, inside = what
 * <ws>/.git is ("none" | "dir" | "other"), id = stateIdOf(…) or null.
 * → { kind: "outside" | "inside" | "inside-fixed" | "conflict" | "none", gitDir, target?, cause? }
 *   inside        the old layout: migrates to `target` at the next sync or restore
 *   inside-fixed  the old layout with no id (a scratch copy): used in place, never migrated
 *   conflict      refused: two git dirs, or a <ws>/.git that is not a directory
 */
export function stateRepoLocation({ claudeHome, workspace, id = null, outside = false, inside = "none" }) {
  const legacy = join(workspace, ".git");
  if (inside === "other") return { kind: "conflict", gitDir: null, cause: `${legacy} is not a directory (a gitfile or a symlink could point git anywhere) — remove it` };
  if (outside && inside === "dir") return { kind: "conflict", gitDir: null, cause: `two git dirs, ${legacy} and ${stateGitDir(claudeHome, id)} — when the second is the migrated copy (the same HEAD), remove ${legacy}` };
  if (outside) return { kind: "outside", gitDir: stateGitDir(claudeHome, id) };
  if (inside === "dir") return id ? { kind: "inside", gitDir: legacy, target: stateGitDir(claudeHome, id) } : { kind: "inside-fixed", gitDir: legacy };
  return { kind: "none", gitDir: null };
}

/**
 * Machine-local anchors of a record store (phase C, goal C4): this machine's writer id, the
 * checkpoints and the store lock, outside every workspace, the state branch and the per-project
 * grant. A key is a workspace id, or store-<16 hex> for a store that is no workspace's own.
 */
export const anchorsRoot = (claudeHome) => join(loopHome(claudeHome), "anchors");
export const isAnchorKey = (key) => isValidId(key) || /^store-[0-9a-f]{16}$/.test(String(key));
export function anchorPaths(claudeHome, key) {
  if (!isAnchorKey(key)) throw new Error(`not an anchor key: ${key}`);
  const root = anchorsRoot(claudeHome);
  return { anchors: join(root, `${key}.jsonl`), writer: join(root, `${key}.writer`), lock: join(root, `${key}.lock`) };
}
/** The anchor key: the workspace id when the store is that workspace's own store, else store-<the first 16 hex of its path digest>. */
export const anchorKey = ({ workspaceId = null, ownStore = false, pathDigest }) => (workspaceId && ownStore ? workspaceId : `store-${String(pathDigest).slice(0, 16)}`);

const RESTORE = "run `loop-setup restore` (it clones the state branch), or `loop-setup init` for a new workspace";

/**
 * Decide the layout from facts. First match wins:
 *   1. envWorkspace (LOOP_SETUP_WORKSPACE): tests and scratch copies; must exist.
 *   2. marker (clone marker id): the workspace under this home; must exist (else restore).
 *   3. link: a symlink whose realpath is a workspace directly under this home's workspaces root.
 *      A real directory or file at the link path never binds (it could be repo-authored).
 *   4. legacy: the in-repo .claude/memory of a project that has not migrated.
 *   5. none: NO_WORKSPACE.
 *
 * facts = { claudeHome, kitRoot, projectRoot|null, inWorktree, envWorkspace: {path, exists}|null,
 *           marker: {id, exists}|null, link: {kind: "missing"|"symlink"|"other", realpath|null}, legacy }
 * Returns { ok: true, mode, kitRoot, projectRoot, workspace, workspaceId, inWorktree, loopHome, warnings }
 *      or { ok: false, code, message, hint, ...the same context fields }.
 */
export function resolveLayout(facts) {
  const { claudeHome, kitRoot, projectRoot = null, inWorktree = false, envWorkspace = null, marker = null, link = { kind: "missing", realpath: null }, legacy = false } = facts;
  const ctx = { kitRoot, projectRoot, inWorktree: !!inWorktree, loopHome: loopHome(claudeHome) };
  const ok = (mode, workspace, workspaceId, warnings = []) => ({ ok: true, mode, ...ctx, workspace, workspaceId, warnings });
  const fail = (code, message, hint, extra = {}) => ({ ok: false, code, message, hint, ...ctx, workspace: null, workspaceId: null, warnings: [], ...extra });

  if (envWorkspace) {
    if (!envWorkspace.exists) return fail("ENV_WORKSPACE_MISSING", `LOOP_SETUP_WORKSPACE=${envWorkspace.path} does not exist`, "unset it, or point it at an existing workspace");
    return ok("env", envWorkspace.path, null);
  }
  if (!projectRoot) return fail("NO_REPO", "not inside a git repository", "run this from a project checkout");

  if (marker) {
    if (!isValidId(marker.id)) return fail("BAD_MARKER", `the clone marker ${MARKER_KEY}=${JSON.stringify(marker.id)} is not a workspace id`, `fix it with \`git config --local ${MARKER_KEY} <id>\``);
    const ws = workspaceDir(claudeHome, marker.id);
    if (!marker.exists) return fail("MISSING_WORKSPACE", `workspace ${marker.id} is not on this machine (${ws})`, RESTORE, { workspaceId: marker.id });
    const warnings = [];
    if (!inWorktree) {
      if (link.kind === "missing") warnings.push("link-missing");
      else if (link.kind !== "symlink") warnings.push("link-not-symlink");
      else if (link.realpath !== ws) warnings.push("link-stale");
    }
    return ok("bound", ws, marker.id, warnings);
  }

  const warnings = [];
  if (link.kind === "symlink") {
    if (isWorkspacePath(link.realpath, claudeHome)) return ok("link", link.realpath, basename(link.realpath));
    warnings.push("link-foreign");
  } else if (link.kind === "other") {
    warnings.push("link-not-symlink");
  }
  if (legacy) return ok("legacy", join(projectRoot, LEGACY_DIR), null, warnings);
  return fail("NO_WORKSPACE", "this project has no loop workspace", RESTORE, { warnings });
}

/**
 * Evidence refs written before the kit left the project tree. reaudit compares a record's cited file
 * at the record's commit with where that file lives now; the facts below say where. They are history,
 * checked against it (layout.test.mjs), and the functions after them are pure.
 */
/**
 * The project root that the kit repo's old records name in absolute refs (they were written in that
 * checkout). Like every rule below it applies only in the kit's own source repository (\`kitRepo\`).
 */
export const LEGACY_PROJECT_ROOTS = ["/home/user/loop-setup"];

/** The commit that moved the loop machinery into kit/. */
export const LEGACY_MOVE_COMMIT = "ec6d24b";

/**
 * Where the move put each file (one source of truth for every rename): [old path, new path], exactly
 * the renames from outside kit/ into kit/ of `git diff -M --name-status ec6d24b^ ec6d24b`.
 */
export const LEGACY_REF_MAP = [
  [".claude/trace/bench/README.md", "kit/bench/README.md"],
  [".claude/trace/bench/fixtures.bundle", "kit/bench/fixtures.bundle"],
  [".claude/commands/bench-checkers.md", "kit/commands/bench-checkers.md"],
  [".claude/commands/critic-round.md", "kit/commands/critic-round.md"],
  [".claude/commands/dream.md", "kit/commands/dream.md"],
  [".claude/commands/fix-localhost.md", "kit/commands/fix-localhost.md"],
  [".claude/commands/improve-skills.md", "kit/commands/improve-skills.md"],
  [".claude/commands/memory-audit.md", "kit/commands/memory-audit.md"],
  [".claude/commands/multi-agent-dev.md", "kit/commands/multi-agent-dev.md"],
  [".claude/commands/multi-agent-e2e.md", "kit/commands/multi-agent-e2e.md"],
  [".claude/commands/plan-nodes.md", "kit/commands/plan-nodes.md"],
  [".claude/commands/qa-pass.md", "kit/commands/qa-pass.md"],
  [".claude/commands/scan-project-docs.md", "kit/commands/scan-project-docs.md"],
  [".claude/commands/story-gap-analysis.md", "kit/commands/story-gap-analysis.md"],
  [".claude/commands/sync-story-status.md", "kit/commands/sync-story-status.md"],
  [".claude/commands/write-goal.md", "kit/commands/write-goal.md"],
  ["docs/adoption-guide.md", "kit/docs/adoption-guide.md"],
  ["docs/loop-integration-guide.md", "kit/docs/loop-integration-guide.md"],
  ["docs/planning-guide.md", "kit/docs/planning-guide.md"],
  ["docs/workflow-graphs.md", "kit/docs/workflow-graphs.md"],
  [".claude/hooks/stop-gate.mjs", "kit/hooks/stop-gate.mjs"],
  ["scripts/hooks/stop-gate.test.mjs", "kit/hooks/stop-gate.test.mjs"],
  [".claude/loop-checklist.md", "kit/loop-checklist.md"],
  [".claude/loop.md", "kit/loop.md"],
  [".claude/trace/schema-v1.json", "kit/schema/schema-v1.json"],
  [".claude/skills-index.md", "kit/skills-index.md"],
  ["scripts/trace/bench-judge.mjs", "kit/trace/bench-judge.mjs"],
  ["scripts/trace/cli.mjs", "kit/trace/cli.mjs"],
  ["scripts/trace/cli.test.mjs", "kit/trace/cli.test.mjs"],
  ["scripts/trace/config.test.mjs", "kit/trace/config.test.mjs"],
  ["scripts/trace/contracts.test.mjs", "kit/trace/contracts.test.mjs"],
  ["scripts/trace/lib.mjs", "kit/trace/lib.mjs"],
  ["scripts/trace/lib.test.mjs", "kit/trace/lib.test.mjs"],
  ["scripts/trace/plan.mjs", "kit/trace/plan.mjs"],
  ["scripts/trace/plan.test.mjs", "kit/trace/plan.test.mjs"],
  ["scripts/trace/story-map.mjs", "kit/trace/story-map.mjs"],
  ["scripts/trace/story-map.test.mjs", "kit/trace/story-map.test.mjs"],
  ["scripts/trace/wiki.test.mjs", "kit/trace/wiki.test.mjs"],
  ["scripts/trace/workflows.test.mjs", "kit/trace/workflows.test.mjs"],
  [".claude/workflows/critic-panel.js", "kit/workflows/critic-panel.js"],
  [".claude/workflows/e2e-design.js", "kit/workflows/e2e-design.js"],
  [".claude/workflows/gap-analysis.js", "kit/workflows/gap-analysis.js"],
  [".claude/workflows/improve-skills.js", "kit/workflows/improve-skills.js"],
  [".claude/workflows/loop-iteration.js", "kit/workflows/loop-iteration.js"],
  [".claude/workflows/scan-docs.js", "kit/workflows/scan-docs.js"],
  [".claude/workflows/trace-bench.js", "kit/workflows/trace-bench.js"],
];

/** Directories the move emptied: a file under one that has no rename above is unmapped, never guessed. */
export const LEGACY_VACATED_DIRS = [".claude/commands/", ".claude/hooks/", ".claude/trace/", ".claude/workflows/", "scripts/hooks/", "scripts/trace/"];

/**
 * Files split in two. Their text before the split matches neither half, so a record older than the
 * split commit is told to re-verify instead of being compared (evidenceHome). `into` names the halves.
 */
export const LEGACY_SPLITS = [
  { from: "CLAUDE.md", at: "4ccf257", into: [{ root: "project", path: "CLAUDE.md" }, { root: "project", path: "kit/rules/KIT.md" }] },
  { from: ".claude/memory/topics/trace.md", at: "ec6d24b", into: [{ root: "workspace", path: "topics/trace.md" }, { root: "project", path: "kit/rules/trace-policy.md" }] },
  { from: ".claude/memory/loop-plan.md", at: "9654bfb", into: [{ root: "workspace", path: "loop-plan.md" }, { root: "project", path: "kit/templates/workspace/loop-plan.md" }] },
];

/**
 * An absolute ref under the project root (`roots`), or in the kit repo (`kitRepo`) under a legacy
 * root, made repo-relative; "./x" is "x"; any other path as it is.
 */
export function normalizeRefPath(path, roots = [], { kitRepo = true } = {}) {
  const p = String(path || "");
  for (const root of [...roots, ...(kitRepo ? LEGACY_PROJECT_ROOTS : [])].map((r) => String(r || "").replace(/\/+$/, "")).filter(Boolean)) {
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p.startsWith("./") ? p.slice(2) : p;
}

/** A normalized path's home, splits aside: { kind, target? }. The kit move's map and vacated dirs apply in the kit repo only. */
function homeOf(p, kitRepo) {
  if (p.startsWith(`${LEGACY_DIR}/`)) return { kind: "workspace", target: { root: "workspace", path: p.slice(LEGACY_DIR.length + 1) } };
  const entry = kitRepo && LEGACY_REF_MAP.find(([from]) => from === p);
  if (entry) return { kind: "moved", target: { root: "project", path: entry[1] } };
  if (p.startsWith("/") || (kitRepo && LEGACY_VACATED_DIRS.some((d) => p.startsWith(d)))) return { kind: "unmapped" };
  return { kind: "unchanged", target: { root: "project", path: p } };
}

/**
 * The one resolution of a path an old record cites (normalized first), exactly one kind: unchanged
 * (the path did not move), moved (a LEGACY_REF_MAP rename), workspace (legacy .claude/memory state),
 * split (LEGACY_SPLITS; `after` is its home when no split applies) or unmapped (an absolute path
 * outside every root, or a file in a vacated directory with no rename). The kit move's facts (its
 * renames, vacated dirs, splits and legacy root) describe the kit's own source repository: with
 * `kitRepo: false` (any adopter project) only the legacy .claude/memory state maps, to the workspace.
 */
export function resolveLegacyRef(path, { roots = [], kitRepo = true } = {}) {
  const p = normalizeRefPath(path, roots, { kitRepo });
  const home = homeOf(p, kitRepo);
  const split = kitRepo && LEGACY_SPLITS.find((s) => s.from === p);
  if (split) return { kind: "split", path: p, at: split.at, into: split.into, after: home };
  return { kind: home.kind, path: p, ...(home.target ? { target: home.target } : {}) };
}

/**
 * What reaudit compares a cited path with: { path, split: at } when the record predates that file's
 * split, else { path, target }: the file's current home, or null when unmapped (the caller fails
 * closed). `predates(at)` is a fact about the record's commit the caller supplies: true, false, or
 * null when the order cannot be known (the split commit is not in the repository), which counts as
 * older: re-verify rather than compare with a half. `exists(path)` says whether the cited path is
 * still in the project: a file still where the record cited it is compared there, whatever the map
 * says. `kitRepo` as in resolveLegacyRef.
 */
export function evidenceHome(cited, { roots = [], predates = () => true, kitRepo = true, exists = () => false } = {}) {
  const ref = resolveLegacyRef(cited, { roots, kitRepo });
  if (ref.kind === "split" && predates(ref.at) !== false) return { path: ref.path, split: ref.at };
  const home = ref.kind === "split" ? ref.after : ref;
  if (home.kind !== "unchanged" && exists(ref.path)) return { path: ref.path, target: { root: "project", path: ref.path } };
  return { path: ref.path, target: home.target || null };
}

/**
 * The current home of a path an old record cites, splits aside: { root: "project", path } for moved
 * machinery (in the kit source repo), { root: "workspace", path } for the legacy .claude/memory state,
 * null for a path that did not move (or that no rename covers).
 */
export function legacyTarget(path) {
  const ref = resolveLegacyRef(path);
  const home = ref.kind === "split" ? ref.after : ref;
  return home.kind === "moved" || home.kind === "workspace" ? home.target : null;
}
