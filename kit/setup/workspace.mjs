// loop-setup workspaces — one per project, at <home>/loop-setup/workspaces/<id>/, itself a small
// git repository whose history is the orphan branch claude/loop-state of the project's own remote.
//   init     create it (from the kit's template, or by moving a legacy .claude/memory in) and bind
//   restore  clone it from claude/loop-state (a fresh machine or cloud session) and bind
//   sync     commit, merge the remote branch (append-only files merge as a union), lint, push
//   bind     the clone marker (.git/config), the git-ignored .claude/loop-workspace link, the
//            .git/info/exclude backup block and the per-project read/write grant
//            (.claude/settings.local.json additionalDirectories)
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { KIT_ROOT, gatherFacts, gitOut } from "./facts.mjs";
import { LEGACY_DIR, LINK_NAME, MARKER_KEY, STATE_BRANCH, isValidId, resolveLayout, workspaceDir, workspacesRoot } from "./layout.mjs";

/** Git for the STATE repository: hardened against the user's global config (hooks, signing, identity). */
const HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.fsmonitor=", "-c", "user.name=loop-setup", "-c", "user.email=loop-setup@localhost"];
export function stateGit(ws, args, { allowFail = false, timeout = 120000 } = {}) {
  const r = spawnSync("git", [...HARDEN, ...args], { cwd: ws, encoding: "utf8", timeout, maxBuffer: 1 << 28 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed in ${ws}: ${(r.stderr || r.error?.message || "").trim().split("\n").slice(-1)[0]}`);
  return r;
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

export const slugify = (name) =>
  String(name || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";

/** The project's origin remote URL, or null. */
export const originUrl = (projectRoot) => gitOut(projectRoot, ["remote", "get-url", "origin"]);

const EXCLUDE_BEGIN = "# >>> loop-setup (managed: the git-ignored workspace link)";
const EXCLUDE_END = "# <<< loop-setup";

/** Write the managed block into the clone's info/exclude (shared by every worktree). */
function writeExclude(projectRoot) {
  const common = gitOut(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  const p = join(common, "info", "exclude");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  // The link, and the per-project grant file init writes (Claude Code's own local settings file).
  const block = `${EXCLUDE_BEGIN}\n/${LINK_NAME}\n/.claude/settings.local.json\n${EXCLUDE_END}\n`;
  const re = new RegExp(`${EXCLUDE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${EXCLUDE_END}\\n?`);
  const next = re.test(text) ? text.replace(re, block) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${block}`;
  if (next !== text) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, next);
  }
  return p;
}

/** Add the workspace realpath to the project's untracked .claude/settings.local.json additionalDirectories. */
function writeGrant(projectRoot, ws) {
  const p = join(projectRoot, ".claude", "settings.local.json");
  const s = readJson(p, {});
  s.permissions = s.permissions || {};
  const dirs = s.permissions.additionalDirectories || [];
  if (!dirs.includes(ws)) {
    s.permissions.additionalDirectories = [...dirs, ws];
    writeJson(p, s);
  }
  return p;
}

/** Create or repair the link: only where nothing is (never over a file, a directory or a foreign link). */
export function ensureLink(projectRoot, ws) {
  const lp = join(projectRoot, LINK_NAME);
  try {
    const st = lstatSync(lp);
    if (!st.isSymbolicLink()) return { link: lp, status: "blocked: not a symlink" };
    if (readlinkSync(lp) === ws) return { link: lp, status: "ok" };
    const target = (() => {
      try {
        return realpathSync(lp);
      } catch {
        return null;
      }
    })();
    if (target === ws) return { link: lp, status: "ok" };
    // Ours if it points into a workspaces root (stale after a restore under another id); else foreign.
    if (/\/loop-setup\/workspaces\/[a-z0-9-]+\/?$/.test(readlinkSync(lp))) {
      unlinkSync(lp);
    } else return { link: lp, status: "blocked: foreign link" };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  mkdirSync(dirname(lp), { recursive: true });
  symlinkSync(ws, lp);
  return { link: lp, status: "created" };
}

/** Is the link path ignored by git (the committed .gitignore line or the exclude block)? */
export const linkIgnored = (projectRoot) => spawnSync("git", ["check-ignore", "-q", "--", LINK_NAME], { cwd: projectRoot }).status === 0;
export const linkTracked = (projectRoot) => spawnSync("git", ["ls-files", "--error-unmatch", "--", LINK_NAME], { cwd: projectRoot, stdio: "ignore" }).status === 0;

/** Bind a project checkout to a workspace: marker, link, exclude block, grant. */
export function bind(projectRoot, id, ws) {
  if (linkTracked(projectRoot)) throw new Error(`${LINK_NAME} is tracked by git in ${projectRoot} — the link must be untracked; remove it from the index first`);
  execFileSync("git", ["config", "--local", MARKER_KEY, id], { cwd: projectRoot });
  const exclude = writeExclude(projectRoot);
  const link = ensureLink(projectRoot, ws);
  const grant = writeGrant(projectRoot, ws);
  return { marker: `${MARKER_KEY}=${id}`, exclude, link, grant, ignored: linkIgnored(projectRoot), gitignoreLine: `/${LINK_NAME}` };
}

const requireProject = (cwd, env) => {
  const facts = gatherFacts({ cwd, env });
  if (!facts.projectRoot) throw new Error("not inside a git repository — run this from a project checkout");
  if (facts.inWorktree) throw new Error("this is a linked worktree — run init/restore/sync from the main checkout");
  return facts;
};

/** Initialise the workspace's own git repo (one commit on the state branch, origin = the project's remote). */
function initStateRepo(ws, remote, message) {
  stateGit(ws, ["init", "-q", "--template=", "-b", STATE_BRANCH]);
  if (remote) stateGit(ws, ["remote", "add", "origin", remote]);
  stateGit(ws, ["add", "-A"]);
  stateGit(ws, ["commit", "-q", "--no-verify", "-m", message]);
}

/**
 * Create the project's workspace and bind it.
 * opts: { cwd, env, fromLegacy?: boolean (default: when a legacy .claude/memory exists), id?, remote? (default origin), now? }
 */
export function init({ cwd = process.cwd(), env = process.env, fromLegacy, id, remote, now = new Date().toISOString() } = {}) {
  const facts = requireProject(cwd, env);
  const { projectRoot, claudeHome } = facts;
  if (facts.marker?.exists) throw new Error(`already initialised: workspace ${facts.marker.id} (${workspaceDir(claudeHome, facts.marker.id)})`);
  const legacyDir = join(projectRoot, LEGACY_DIR);
  const useLegacy = fromLegacy ?? facts.legacy;
  if (useLegacy && !facts.legacy) throw new Error(`--from-legacy: no legacy state at ${legacyDir}`);
  const wsId = id || `${slugify(basename(projectRoot))}-${randomBytes(4).toString("hex")}`;
  if (!isValidId(wsId)) throw new Error(`not a workspace id: ${wsId}`);
  const ws = workspaceDir(claudeHome, wsId);
  if (existsSync(ws)) throw new Error(`${ws} already exists`);
  const stage = mkdtempSync(join(tmpdir(), "loop-ws-"));
  try {
    cpSync(join(KIT_ROOT, "templates/workspace"), stage, { recursive: true });
    if (useLegacy) cpSync(legacyDir, stage, { recursive: true, force: true });
    const origin = remote === undefined ? originUrl(projectRoot) : remote;
    writeJson(join(stage, "workspace.json"), {
      schema: 1,
      id: wsId,
      project: { name: basename(projectRoot) },
      state: { branch: STATE_BRANCH },
      createdAt: now,
      ...(useLegacy ? { migratedFrom: { path: LEGACY_DIR, commit: gitOut(projectRoot, ["rev-parse", "HEAD"]) } } : {}),
    });
    initStateRepo(stage, origin, useLegacy ? `loop-state: migrate ${LEGACY_DIR} into workspace ${wsId}` : `loop-state: init workspace ${wsId}`);
    mkdirSync(workspacesRoot(claudeHome), { recursive: true });
    renameSync(stage, ws);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return { id: wsId, workspace: ws, fromLegacy: !!useLegacy, ...bind(projectRoot, wsId, ws) };
}

/** Does the remote have the state branch? null when it cannot be asked. */
export function remoteHasState(remote, branch = STATE_BRANCH) {
  const r = spawnSync("git", ["ls-remote", "--heads", remote, branch], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
}

/**
 * Bring the workspace onto this machine from the project's remote and bind it. A workspace that
 * is already here is fast-forwarded (pull) instead. Never creates state from nothing.
 */
export function restore({ cwd = process.cwd(), env = process.env } = {}) {
  const facts = requireProject(cwd, env);
  const { projectRoot, claudeHome } = facts;
  if (facts.marker?.exists) {
    const ws = workspaceDir(claudeHome, facts.marker.id);
    const pulled = pull(ws);
    return { id: facts.marker.id, workspace: ws, restored: false, pulled, ...bind(projectRoot, facts.marker.id, ws) };
  }
  const remote = originUrl(projectRoot);
  if (!remote) throw new Error("the project has no origin remote to restore the workspace from — run `loop-setup init`");
  const has = remoteHasState(remote);
  if (has === null) throw new Error(`cannot reach ${remote} to look for ${STATE_BRANCH}`);
  if (!has) throw new Error(`the remote has no ${STATE_BRANCH} branch yet — run \`loop-setup init\` (and \`loop-setup sync\` to publish it)`);
  const stage = mkdtempSync(join(tmpdir(), "loop-ws-"));
  rmSync(stage, { recursive: true, force: true });
  const clone = spawnSync("git", [...HARDEN, "clone", "-q", "--template=", "--single-branch", "--branch", STATE_BRANCH, remote, stage], { encoding: "utf8", timeout: 300000 });
  if (clone.status !== 0) throw new Error(`git clone of ${STATE_BRANCH} failed: ${(clone.stderr || "").trim().split("\n").slice(-1)[0]}`);
  const meta = readJson(join(stage, "workspace.json"), null);
  if (!meta || !isValidId(meta.id)) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`${STATE_BRANCH} has no valid workspace.json — it is not a loop-setup state branch`);
  }
  const ws = workspaceDir(claudeHome, meta.id);
  if (existsSync(ws)) {
    rmSync(stage, { recursive: true, force: true });
    const pulled = pull(ws);
    return { id: meta.id, workspace: ws, restored: false, pulled, ...bind(projectRoot, meta.id, ws) };
  }
  mkdirSync(workspacesRoot(claudeHome), { recursive: true });
  renameSync(stage, ws);
  return { id: meta.id, workspace: ws, restored: true, pulled: false, ...bind(projectRoot, meta.id, ws) };
}

/** Fetch the remote state branch and merge it (union for append-only files). Returns a short status. */
export function pull(ws) {
  if (!stateGit(ws, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim()) return "no remote";
  const fetched = stateGit(ws, ["fetch", "-q", "origin", STATE_BRANCH], { allowFail: true });
  if (fetched.status !== 0) return /couldn't find remote ref|not found/i.test(fetched.stderr) ? "remote branch absent" : "fetch failed";
  const merged = stateGit(ws, ["merge", "-q", "--no-edit", "FETCH_HEAD"], { allowFail: true });
  if (merged.status !== 0) {
    stateGit(ws, ["merge", "--abort"], { allowFail: true });
    return "conflict (merge aborted; local state kept)";
  }
  return "merged";
}

/** Uncommitted changes and commits the remote branch does not have (as of the last fetch). */
export function syncStatus(ws) {
  const dirty = stateGit(ws, ["status", "--porcelain"], { allowFail: true }).stdout.trim().split("\n").filter(Boolean).length;
  const hasRemote = !!stateGit(ws, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim();
  let ahead = 0;
  if (hasRemote) {
    const base = stateGit(ws, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${STATE_BRANCH}`], { allowFail: true }).stdout.trim();
    ahead = Number(stateGit(ws, ["rev-list", "--count", base ? `${base}..HEAD` : "HEAD"], { allowFail: true }).stdout.trim() || 0);
  }
  return { dirty, ahead, hasRemote, synced: dirty === 0 && (!hasRemote || ahead === 0) };
}

/** `loop-setup lint` (store replay) and `wiki-check` against a workspace, as processes. */
function lintGate(ws) {
  const cli = join(KIT_ROOT, "trace/cli.mjs");
  const env = { ...process.env, LOOP_SETUP_WORKSPACE: ws };
  delete env.TRACE_STORE;
  const problems = [];
  for (const cmd of ["lint", "wiki-check"]) {
    const r = spawnSync(process.execPath, [cli, cmd], { cwd: ws, encoding: "utf8", env });
    if (r.status !== 0) problems.push(`${cmd}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(0, 3).join(" | ")}`);
  }
  return problems;
}

/** The bound workspace of cwd's project, or throw with the layout's hint. */
export function boundWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  const layout = resolveLayout(gatherFacts({ cwd, env }));
  if (!layout.ok) throw new Error(`[layout:${layout.code}] ${layout.message} — ${layout.hint}`);
  if (layout.mode === "legacy") throw new Error(`this project still keeps its state in ${LEGACY_DIR} — run \`loop-setup init --from-legacy\` first`);
  if (!existsSync(join(layout.workspace, ".git"))) throw new Error(`${layout.workspace} is not a git repository — it cannot be synced`);
  return layout;
}

/**
 * Commit the workspace, merge the remote state branch, check it (lint + wiki-check), push.
 * opts: { cwd, env, message?, force? (push even when the gate fails), push? (default true) }
 */
export function sync({ cwd = process.cwd(), env = process.env, message, force = false, push = true, now = new Date().toISOString() } = {}) {
  const layout = boundWorkspace({ cwd, env });
  const ws = layout.workspace;
  const before = lintGate(ws);
  if (before.length && !force) return { ok: false, stage: "pre-lint", problems: before, workspace: ws };
  stateGit(ws, ["add", "-A"]);
  const staged = stateGit(ws, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;
  if (staged) stateGit(ws, ["commit", "-q", "--no-verify", "-m", message || `loop-state: ${now}`]);
  const pulled = pull(ws);
  if (pulled.startsWith("conflict")) return { ok: false, stage: "merge", problems: [pulled], workspace: ws, committed: staged };
  const after = lintGate(ws);
  if (after.length && !force) return { ok: false, stage: "post-merge lint", problems: after, workspace: ws, committed: staged, pulled };
  let pushed = false;
  if (push && stateGit(ws, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim()) {
    const r = stateGit(ws, ["push", "-q", "origin", `HEAD:refs/heads/${STATE_BRANCH}`], { allowFail: true, timeout: 300000 });
    if (r.status !== 0) return { ok: false, stage: "push", problems: [(r.stderr || "").trim().split("\n").slice(-2).join(" | ")], workspace: ws, committed: staged, pulled };
    stateGit(ws, ["fetch", "-q", "origin", STATE_BRANCH], { allowFail: true });
    stateGit(ws, ["update-ref", `refs/remotes/origin/${STATE_BRANCH}`, "HEAD"], { allowFail: true });
    pushed = true;
  }
  return { ok: true, workspace: ws, committed: staged, pulled, pushed, branch: STATE_BRANCH };
}
