// loop-setup workspaces — one per project, at <home>/loop-setup/workspaces/<id>/, itself a small
// git repository whose history is the orphan branch claude/loop-state of the project's own remote.
//   init     create it (from the kit's template, or by moving a legacy .claude/memory in) and bind
//   restore  clone it from claude/loop-state (a fresh machine or cloud session) and bind
//   sync     commit, merge the remote branch (append-only files merge as a union), lint, push
//   bind     the clone marker (.git/config), the git-ignored .claude/loop-workspace link, the
//            .git/info/exclude backup block and the per-project read/write grant
//            (.claude/settings.local.json additionalDirectories)
// The workspace's git dir is NOT in the workspace: it is <home>/loop-setup/state/<id>.git, outside
// the grant (phase C, goal C3). Every state git call names it and the work tree explicitly, and runs
// only after the guard (stateguard.mjs) has found nothing planted that git could execute.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { KIT_ROOT, gatherFacts, gitOut } from "./facts.mjs";
import { LEGACY_DIR, LINK_NAME, MARKER_KEY, STATE_BRANCH, isValidId, isWorkspacePath, resolveLayout, stateGitDir, stateIdOf, stateRepoLocation, stateRoot, workspaceDir, workspacesRoot } from "./layout.mjs";
import { GITDIR_ENTRIES, incomingTreeRefusal, stateRepoRefusal } from "./stateguard.mjs";

/** Git for the STATE repository: hardened against the user's global config (hooks, signing, identity). */
// core.autocrlf=false: a user's global autocrlf must not rewrite the template .gitattributes at checkout.
const HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.fsmonitor=", "-c", "core.autocrlf=false", "-c", "user.name=loop-setup", "-c", "user.email=loop-setup@localhost"];
/** The caller's environment minus what would point git at another repository, index or object store. */
const gitEnv = () => {
  const e = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete e[k];
  return e;
};
/** Hardened git with no guard: the bootstrap calls (init, clone, the first checkout) and the guard's own reads. */
function rawGit(args, { cwd, allowFail = false, timeout = 120000 } = {}) {
  const r = spawnSync("git", [...HARDEN, ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 1 << 28, env: gitEnv() });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim().split("\n").slice(-1)[0]}`);
  return r;
}

/** git refused to run on a state repo because something planted could make it run a command (exit 2 at the CLI). */
export class StateRepoRefused extends Error {
  constructor(refusal) {
    super(`state repo refused: ${refusal}`);
    this.name = "StateRepoRefused";
    this.refusal = refusal;
  }
}

const lkind = (p) => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "none";
  }
};
/** Every .gitattributes and .gitmodules in a work tree (paths relative to it; any .git is skipped). */
function treeFiles(workTree) {
  const attributes = [];
  const gitmodules = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      const rel = relative(workTree, p).split(sep).join("/");
      const name = e.name.toLowerCase(); // git opens these case-insensitively on macOS and Windows
      if (e.isDirectory()) walk(p);
      else if (name === ".gitattributes") attributes.push({ path: rel, content: e.isFile() ? readFileSync(p, "utf8") : "" }); // a symlink never matches the template
      else if (name === ".gitmodules") gitmodules.push(rel);
    }
  };
  walk(workTree);
  return { attributes, gitmodules };
}
/** The state repo's own config file as [[key, value]] (`--file` reads that file only and never follows include.*). */
function configEntries(gitDir) {
  const r = rawGit(["config", "--file", join(gitDir, "config"), "-z", "--list"], { cwd: gitDir, allowFail: true });
  if (r.status !== 0) return [];
  return r.stdout.split("\0").filter(Boolean).map((kv) => {
    const i = kv.indexOf("\n");
    return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
  });
}
const gitDirEntries = (gitDir) => GITDIR_ENTRIES.filter((e) => lkind(join(gitDir, e)) !== "none");
/** Throw StateRepoRefused when the guard finds anything planted in the work tree or the git dir. */
function guard({ gitDir, workTree }) {
  const r = stateRepoRefusal({ ...treeFiles(workTree), config: configEntries(gitDir), gitDirEntries: gitDirEntries(gitDir) });
  if (r) throw new StateRepoRefused(r.cause);
}

/** Git for a state repo { gitDir, workTree }: the guard first, then explicit --git-dir/--work-tree and HARDEN. */
export function stateGit(repo, args, { allowFail = false, timeout = 120000 } = {}) {
  guard(repo);
  return rawGit([`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...args], { cwd: repo.workTree, allowFail, timeout });
}

/** A commit's tree as the guard reads it: its paths and its root .gitattributes (object reads only). */
function treeAt(git, rev) {
  const ls = git(["ls-tree", "-r", "-z", "--name-only", rev]);
  if (ls.status !== 0) throw new Error(`cannot list ${rev}: ${(ls.stderr || "").trim()}`);
  const paths = ls.stdout.split("\0").filter(Boolean);
  const rootAttributes = paths.includes(".gitattributes") ? git(["cat-file", "blob", `${rev}:.gitattributes`]).stdout : null;
  return { paths, rootAttributes };
}

/** Where a workspace's git dir is (stateRepoLocation over what is on disk), with its work tree. */
export function stateRepo({ claudeHome, workspace, workspaceId = null }) {
  const id = stateIdOf({ claudeHome, workspace, workspaceId });
  const outside = !!id && lkind(stateGitDir(claudeHome, id)) === "dir";
  const inside = { none: "none", dir: "dir" }[lkind(join(workspace, ".git"))] || "other";
  return { ...stateRepoLocation({ claudeHome, workspace, id, outside, inside }), id, claudeHome, workTree: workspace };
}

/** The { gitDir, workTree } of a location git may use, or throw (a conflict is a refusal). */
function openRepo(loc) {
  if (loc.kind === "conflict") throw new StateRepoRefused(loc.cause);
  if (!loc.gitDir) throw new Error(`${loc.workTree} has no state git repository — it cannot be synced; re-create it with init or restore`);
  return { gitDir: loc.gitDir, workTree: loc.workTree };
}

const tmpGitDir = (claudeHome) => {
  mkdirSync(stateRoot(claudeHome), { recursive: true });
  return join(stateRoot(claudeHome), `.tmp-${randomBytes(6).toString("hex")}.git`);
};
/** A file's text when it is a regular file, else null (never follows a symlink). */
const regularText = (p) => (lkind(p) === "file" ? readFileSync(p, "utf8") : null);
/** Copy the regular files under src into dst (directories recreated; symlinks and others skipped). */
function copyRegular(src, dst, skip = () => false) {
  if (lkind(src) !== "dir") return;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(src, p).split(sep).join("/");
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        mkdirSync(dirname(join(dst, rel)), { recursive: true });
        copyFileSync(p, join(dst, rel));
      }
    }
  };
  walk(src);
}
/** An old-layout git dir's HEAD, read from its files (no git runs there): { raw, commit }. */
function legacyHead(gitDir) {
  const raw = regularText(join(gitDir, "HEAD"));
  const id = (s) => (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s) ? s : null);
  const direct = id(String(raw || "").trim());
  if (direct) return { raw: `${direct}\n`, commit: direct };
  const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\s*$/.exec(String(raw || ""))?.[1];
  if (!ref || ref.includes("..")) throw new StateRepoRefused(`${join(gitDir, "HEAD")} is not a branch or a commit id — the old git dir cannot be migrated`);
  const loose = id(String(regularText(join(gitDir, ref)) || "").trim());
  const packed = String(regularText(join(gitDir, "packed-refs")) || "")
    .split("\n")
    .map((l) => l.split(" "))
    .find(([, name]) => name === ref)?.[0];
  const commit = loose || id(String(packed || ""));
  if (!commit) throw new StateRepoRefused(`${ref} of ${gitDir} does not resolve to a commit — the old git dir cannot be migrated`);
  return { raw: `ref: ${ref}\n`, commit };
}

/**
 * Move an old-layout workspace (<ws>/.git) to state/<id>.git. The old git dir sat in the writable
 * workspace and may carry commondir, config.worktree, alternates or hooks, so it is never renamed and
 * no git command runs in it: a fresh git dir is built from its objects, refs, packed-refs, reflogs and
 * HEAD (plain files) and its remote URL, checked (same HEAD, connected), renamed into place, and only
 * then is the old one removed. Any failure before the rename leaves the old layout as it was.
 */
export function migrate(loc, { remote = null } = {}) {
  if (loc.kind !== "inside") return loc;
  const legacy = loc.gitDir;
  const head = legacyHead(legacy);
  const url = remote; // the project's origin, as init sets it — never the old config's URL, which is as untrusted as the rest
  const tmp = tmpGitDir(loc.claudeHome);
  const stage = mkdtempSync(join(tmpdir(), "loop-mig-"));
  try {
    rawGit(["init", "-q", "--template=", `--separate-git-dir=${tmp}`, stage]);
    copyRegular(join(legacy, "objects"), join(tmp, "objects"), (rel) => rel === "info" || rel.startsWith("info/"));
    copyRegular(join(legacy, "refs"), join(tmp, "refs"));
    copyRegular(join(legacy, "logs"), join(tmp, "logs"));
    if (lkind(join(legacy, "packed-refs")) === "file") copyFileSync(join(legacy, "packed-refs"), join(tmp, "packed-refs"));
    writeFileSync(join(tmp, "HEAD"), head.raw);
    const repo = { gitDir: tmp, workTree: loc.workTree };
    if (url) stateGit(repo, ["remote", "add", "--", "origin", url]);
    stateGit(repo, ["read-tree", "HEAD"]);
    stateGit(repo, ["fsck", "--connectivity-only", "--no-dangling", "--no-progress"]);
    const now = stateGit(repo, ["rev-parse", "HEAD"]).stdout.trim();
    if (now !== head.commit) throw new Error(`the rebuilt git dir's HEAD ${now} is not the old ${head.commit}`);
    renameSync(tmp, loc.target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  rmSync(legacy, { recursive: true, force: true });
  return { ...loc, kind: "outside", gitDir: loc.target, migrated: true };
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
export function ensureLink(projectRoot, ws, claudeHome) {
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
    // Ours only if it points directly into THIS home's workspaces root (stale after a restore under
    // another id); a link anywhere else — another home's workspaces included — is foreign.
    if (isWorkspacePath(resolve(dirname(lp), readlinkSync(lp)), claudeHome)) {
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
export function bind(projectRoot, id, ws, claudeHome) {
  if (linkTracked(projectRoot)) throw new Error(`${LINK_NAME} is tracked by git in ${projectRoot} — the link must be untracked; remove it from the index first`);
  execFileSync("git", ["config", "--local", MARKER_KEY, id], { cwd: projectRoot });
  const exclude = writeExclude(projectRoot);
  const link = ensureLink(projectRoot, ws, claudeHome);
  const grant = writeGrant(projectRoot, ws);
  return { marker: `${MARKER_KEY}=${id}`, exclude, link, grant, ignored: linkIgnored(projectRoot), gitignoreLine: `/${LINK_NAME}` };
}

const requireProject = (cwd, env) => {
  const facts = gatherFacts({ cwd, env });
  if (!facts.projectRoot) throw new Error("not inside a git repository — run this from a project checkout");
  if (facts.inWorktree) throw new Error("this is a linked worktree — run init/restore/sync from the main checkout");
  return facts;
};

/**
 * Initialise the workspace's git repo in a temporary git dir beside the stage (one commit on the
 * state branch, origin = the project's remote). Bootstrap: `git init` runs unguarded (no git dir yet);
 * every call after it goes through the guard.
 */
function initStateRepo(stage, tmp, remote, message) {
  rawGit(["init", "-q", "--template=", "-b", STATE_BRANCH, `--separate-git-dir=${tmp}`, stage]);
  rmSync(join(stage, ".git")); // the gitfile: the git dir is always named explicitly
  const repo = { gitDir: tmp, workTree: stage };
  if (remote) stateGit(repo, ["remote", "add", "--", "origin", remote]);
  stateGit(repo, ["add", "-A"]);
  stateGit(repo, ["commit", "-q", "--no-verify", "-m", message]);
}

/** Rename a finished git dir and stage into place, the git dir first; undo the first rename if the second fails. */
function placeRepo(tmp, target, stage, ws) {
  renameSync(tmp, target);
  try {
    renameSync(stage, ws);
  } catch (e) {
    renameSync(target, tmp);
    throw e;
  }
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
  const target = stateGitDir(claudeHome, wsId);
  if (lkind(target) !== "none") throw new Error(`${target} already exists — a git dir for workspace ${wsId} is already on this machine: restore it, or move it aside`);
  const stage = mkdtempSync(join(tmpdir(), "loop-ws-"));
  const tmp = tmpGitDir(claudeHome);
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
    initStateRepo(stage, tmp, origin, useLegacy ? `loop-state: migrate ${LEGACY_DIR} into workspace ${wsId}` : `loop-state: init workspace ${wsId}`);
    mkdirSync(workspacesRoot(claudeHome), { recursive: true });
    placeRepo(tmp, target, stage, ws);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { id: wsId, workspace: ws, fromLegacy: !!useLegacy, ...bind(projectRoot, wsId, ws, claudeHome) };
}

/** Does the remote have the state branch? null when it cannot be asked. */
export function remoteHasState(remote, branch = STATE_BRANCH) {
  const r = spawnSync("git", ["ls-remote", "--heads", remote, branch], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
}

/** The state repo of a workspace already on this machine, migrated out of the workspace when it still has <ws>/.git. */
const localRepo = (claudeHome, ws, workspaceId, projectRoot) => migrate(stateRepo({ claudeHome, workspace: ws, workspaceId }), { remote: projectRoot ? originUrl(projectRoot) : null });

/**
 * Bring the workspace onto this machine from the project's remote and bind it. A workspace that
 * is already here is fast-forwarded (pull) instead, after migrating it out of the workspace. Never
 * creates state from nothing. The clone lands in a temporary git dir with no checkout; its tree is
 * checked by the guard before anything reaches a work tree, and both are renamed into place last.
 * A git dir left with no workspace (an orphan) is moved aside, kept and named in the result.
 */
export function restore({ cwd = process.cwd(), env = process.env } = {}) {
  const facts = requireProject(cwd, env);
  const { projectRoot, claudeHome } = facts;
  if (facts.marker?.exists) {
    const ws = workspaceDir(claudeHome, facts.marker.id);
    const loc = localRepo(claudeHome, ws, facts.marker.id, projectRoot);
    const pulled = pull(openRepo(loc));
    return { id: facts.marker.id, workspace: ws, restored: false, pulled, ...(loc.migrated ? { migrated: loc.gitDir } : {}), ...bind(projectRoot, facts.marker.id, ws, claudeHome) };
  }
  const remote = originUrl(projectRoot);
  if (!remote) throw new Error("the project has no origin remote to restore the workspace from — run `loop-setup init`");
  const has = remoteHasState(remote);
  if (has === null) throw new Error(`cannot reach ${remote} to look for ${STATE_BRANCH}`);
  if (!has) throw new Error(`the remote has no ${STATE_BRANCH} branch yet — run \`loop-setup init\` (and \`loop-setup sync\` to publish it)`);
  const stage = mkdtempSync(join(tmpdir(), "loop-ws-"));
  rmSync(stage, { recursive: true, force: true });
  const tmp = tmpGitDir(claudeHome);
  const cleanup = () => {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const clone = rawGit(["clone", "-q", "--no-checkout", "--template=", "--single-branch", "--branch", STATE_BRANCH, `--separate-git-dir=${tmp}`, remote, stage], { allowFail: true, timeout: 300000 });
    if (clone.status !== 0) throw new Error(`git clone of ${STATE_BRANCH} failed: ${(clone.stderr || "").trim().split("\n").slice(-1)[0]}`);
    rmSync(join(stage, ".git")); // the gitfile: the git dir is always named explicitly
    const inTmp = (args) => rawGit([`--git-dir=${tmp}`, ...args], { cwd: stage, allowFail: true });
    const tree = treeAt(inTmp, "HEAD");
    const refused = incomingTreeRefusal(tree) || stateRepoRefusal({ attributes: [{ path: ".gitattributes", content: tree.rootAttributes }], config: configEntries(tmp), gitDirEntries: gitDirEntries(tmp) });
    if (refused) throw new StateRepoRefused(`the cloned ${STATE_BRANCH}: ${refused.cause}`);
    const meta = (() => {
      try {
        return JSON.parse(inTmp(["cat-file", "blob", "HEAD:workspace.json"]).stdout);
      } catch {
        return null;
      }
    })();
    if (!meta || !isValidId(meta.id)) throw new Error(`${STATE_BRANCH} has no valid workspace.json — it is not a loop-setup state branch`);
    const ws = workspaceDir(claudeHome, meta.id);
    if (existsSync(ws)) {
      cleanup();
      const loc = localRepo(claudeHome, ws, meta.id, projectRoot);
      const pulled = pull(openRepo(loc));
      return { id: meta.id, workspace: ws, restored: false, pulled, ...(loc.migrated ? { migrated: loc.gitDir } : {}), ...bind(projectRoot, meta.id, ws, claudeHome) };
    }
    // Bootstrap checkout of the tree the guard just passed, then the work-tree rules on the result.
    rawGit([`--git-dir=${tmp}`, `--work-tree=${stage}`, "checkout", "-q", "-f", STATE_BRANCH], { cwd: stage });
    guard({ gitDir: tmp, workTree: stage });
    const target = stateGitDir(claudeHome, meta.id);
    let orphan = null;
    if (lkind(target) !== "none") {
      orphan = `${target}.orphan-${randomBytes(4).toString("hex")}`;
      renameSync(target, orphan);
    }
    mkdirSync(workspacesRoot(claudeHome), { recursive: true });
    try {
      placeRepo(tmp, target, stage, ws);
    } catch (e) {
      if (orphan) renameSync(orphan, target);
      throw e;
    }
    return { id: meta.id, workspace: ws, restored: true, pulled: false, ...(orphan ? { orphan } : {}), ...bind(projectRoot, meta.id, ws, claudeHome) };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Fetch the remote state branch, check its tree, and merge it (union for append-only files). Returns a short status. */
export function pull(repo) {
  if (!stateGit(repo, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim()) return "no remote";
  const fetched = stateGit(repo, ["fetch", "-q", "origin", STATE_BRANCH], { allowFail: true });
  if (fetched.status !== 0) return /couldn't find remote ref|not found/i.test(fetched.stderr) ? "remote branch absent" : "fetch failed";
  const refused = incomingTreeRefusal(treeAt((args) => stateGit(repo, args, { allowFail: true }), "FETCH_HEAD"));
  if (refused) throw new StateRepoRefused(`the fetched ${STATE_BRANCH}: ${refused.cause}`);
  const merged = stateGit(repo, ["merge", "-q", "--no-edit", "FETCH_HEAD"], { allowFail: true });
  if (merged.status !== 0) {
    stateGit(repo, ["merge", "--abort"], { allowFail: true });
    return "conflict (merge aborted; local state kept)";
  }
  return "merged";
}

/** Uncommitted changes and commits the remote branch does not have (as of the last fetch), for a stateRepo() location. */
export function syncStatus(loc) {
  const repo = openRepo(loc);
  const dirty = stateGit(repo, ["status", "--porcelain"], { allowFail: true }).stdout.trim().split("\n").filter(Boolean).length;
  const hasRemote = !!stateGit(repo, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim();
  let ahead = 0;
  if (hasRemote) {
    const base = stateGit(repo, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${STATE_BRANCH}`], { allowFail: true }).stdout.trim();
    ahead = Number(stateGit(repo, ["rev-list", "--count", base ? `${base}..HEAD` : "HEAD"], { allowFail: true }).stdout.trim() || 0);
  }
  return { dirty, ahead, hasRemote, synced: dirty === 0 && (!hasRemote || ahead === 0) };
}

/**
 * `loop-setup lint` (store replay) and `wiki-check` against a workspace, as processes. No git call
 * inside them may discover a repository above the workspace (it has no .git of its own any more).
 */
function lintGate(ws) {
  const cli = join(KIT_ROOT, "trace/cli.mjs");
  const env = { ...process.env, LOOP_SETUP_WORKSPACE: ws, GIT_CEILING_DIRECTORIES: realpathSync(dirname(ws)) };
  delete env.TRACE_STORE;
  const problems = [];
  for (const cmd of ["lint", "wiki-check"]) {
    const r = spawnSync(process.execPath, [cli, cmd], { cwd: ws, encoding: "utf8", env });
    if (r.status !== 0) problems.push(`${cmd}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(0, 3).join(" | ")}`);
  }
  return problems;
}

/** The bound workspace of cwd's project (with its Claude home), or throw with the layout's hint. */
export function boundWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  const facts = gatherFacts({ cwd, env });
  const layout = resolveLayout(facts);
  if (!layout.ok) throw new Error(`[layout:${layout.code}] ${layout.message} — ${layout.hint}`);
  if (layout.mode === "legacy") throw new Error(`this project still keeps its state in ${LEGACY_DIR} — run \`loop-setup init --from-legacy\` first`);
  if (stateRepo({ claudeHome: facts.claudeHome, workspace: layout.workspace, workspaceId: layout.workspaceId }).kind === "none") throw new Error(`${layout.workspace} has no state git repository — it cannot be synced`);
  return { ...layout, claudeHome: facts.claudeHome };
}

/**
 * Commit the workspace, merge the remote state branch, check it (lint + wiki-check), push. An
 * old-layout workspace is migrated out of the workspace first.
 * opts: { cwd, env, message?, force? (push even when the gate fails), push? (default true) }
 */
export function sync({ cwd = process.cwd(), env = process.env, message, force = false, push = true, now = new Date().toISOString() } = {}) {
  const layout = boundWorkspace({ cwd, env });
  const ws = layout.workspace;
  const loc = localRepo(layout.claudeHome, ws, layout.workspaceId, layout.projectRoot);
  const repo = openRepo(loc);
  const migrated = loc.migrated ? { migrated: loc.gitDir } : {};
  const before = lintGate(ws);
  if (before.length && !force) return { ok: false, stage: "pre-lint", problems: before, workspace: ws, ...migrated };
  stateGit(repo, ["add", "-A"]);
  const staged = stateGit(repo, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;
  if (staged) stateGit(repo, ["commit", "-q", "--no-verify", "-m", message || `loop-state: ${now}`]);
  const pulled = pull(repo);
  if (pulled.startsWith("conflict")) return { ok: false, stage: "merge", problems: [pulled], workspace: ws, committed: staged, ...migrated };
  const after = lintGate(ws);
  if (after.length && !force) return { ok: false, stage: "post-merge lint", problems: after, workspace: ws, committed: staged, pulled, ...migrated };
  let pushed = false;
  if (push && stateGit(repo, ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim()) {
    const r = stateGit(repo, ["push", "-q", "origin", `HEAD:refs/heads/${STATE_BRANCH}`], { allowFail: true, timeout: 300000 });
    if (r.status !== 0) return { ok: false, stage: "push", problems: [(r.stderr || "").trim().split("\n").slice(-2).join(" | ")], workspace: ws, committed: staged, pulled, ...migrated };
    stateGit(repo, ["fetch", "-q", "origin", STATE_BRANCH], { allowFail: true });
    stateGit(repo, ["update-ref", `refs/remotes/origin/${STATE_BRANCH}`, "HEAD"], { allowFail: true });
    pushed = true;
  }
  return { ok: true, workspace: ws, committed: staged, pulled, pushed, branch: STATE_BRANCH, ...migrated };
}
