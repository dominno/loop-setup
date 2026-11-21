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

/** The absolute state paths under a workspace. */
export function statePaths(workspace) {
  return Object.fromEntries(Object.entries(STATE_PATHS).map(([k, rel]) => [k, join(workspace, rel)]));
}

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

  const root = workspacesRoot(claudeHome);
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
    const id = link.realpath ? basename(link.realpath) : null;
    if (link.realpath && isValidId(id) && link.realpath === join(root, id)) return ok("link", link.realpath, id);
    warnings.push("link-foreign");
  } else if (link.kind === "other") {
    warnings.push("link-not-symlink");
  }
  if (legacy) return ok("legacy", join(projectRoot, LEGACY_DIR), null, warnings);
  return fail("NO_WORKSPACE", "this project has no loop workspace", RESTORE, { warnings });
}

/**
 * Where the kit moved things when it left the project tree (one source of truth for every
 * rename): [legacy prefix, new prefix]. A prefix ending in "/" maps a directory, otherwise a file.
 */
export const LEGACY_REF_MAP = [
  [".claude/workflows/", "kit/workflows/"],
  [".claude/commands/", "kit/commands/"],
  [".claude/hooks/", "kit/hooks/"],
  [".claude/trace/bench/", "kit/bench/"],
  [".claude/trace/schema-v1.json", "kit/schema/schema-v1.json"],
  [".claude/loop.md", "kit/loop.md"],
  [".claude/loop-checklist.md", "kit/loop-checklist.md"],
  [".claude/skills-index.md", "kit/skills-index.md"],
  ["scripts/trace/", "kit/trace/"],
  ["scripts/hooks/", "kit/hooks/"],
  ["docs/planning-guide.md", "kit/docs/planning-guide.md"],
  ["docs/workflow-graphs.md", "kit/docs/workflow-graphs.md"],
  ["docs/adoption-guide.md", "kit/docs/adoption-guide.md"],
  ["docs/loop-integration-guide.md", "kit/docs/loop-integration-guide.md"],
];

/**
 * The current home of a path an old record cites: { root: "project", path } for moved machinery
 * (in the kit source repo), { root: "workspace", path } for the legacy .claude/memory state,
 * null for a path that did not move.
 */
export function legacyTarget(path) {
  const p = String(path || "");
  if (p.startsWith(`${LEGACY_DIR}/`)) return { root: "workspace", path: p.slice(LEGACY_DIR.length + 1) };
  for (const [from, to] of LEGACY_REF_MAP) {
    if (from.endsWith("/") ? p.startsWith(from) : p === from) return { root: "project", path: to + p.slice(from.length) };
  }
  return null;
}
