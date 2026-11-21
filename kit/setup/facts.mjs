// Loop-setup facts — the driven adapter that reads git, the filesystem and the environment for
// the pure layout core (kit/setup/layout.mjs). The only module here that touches cwd/env/home.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_DIR, LINK_NAME, MARKER_KEY, resolveLayout, workspaceDir } from "./layout.mjs";

/** The kit's own root (the directory that holds kit.json). */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run git in a directory; null on any failure (no repo, no such key). */
export function gitOut(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** The Claude config dir: $CLAUDE_CONFIG_DIR, else <HOME>/.claude. */
export function claudeHomeOf(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return resolve(env.CLAUDE_CONFIG_DIR);
  return join(env.HOME || homedir(), ".claude");
}

/** What the layout core needs to know, read from git and the filesystem. */
export function gatherFacts({ cwd = process.cwd(), env = process.env } = {}) {
  const claudeHome = claudeHomeOf(env);
  const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  const projectRoot = top ? real(top) : null;
  let inWorktree = false;
  let marker = null;
  let link = { kind: "missing", realpath: null };
  let legacy = false;
  if (projectRoot) {
    const gitDir = real(resolve(projectRoot, gitOut(projectRoot, ["rev-parse", "--git-dir"]) || ".git"));
    const commonDir = real(resolve(projectRoot, gitOut(projectRoot, ["rev-parse", "--git-common-dir"]) || ".git"));
    inWorktree = !!gitDir && !!commonDir && gitDir !== commonDir;
    const id = gitOut(projectRoot, ["config", "--get", MARKER_KEY]);
    if (id) marker = { id, exists: isDir(workspaceDir(claudeHome, id)) && /^[a-z0-9][a-z0-9-]*$/.test(id) };
    const lp = join(projectRoot, LINK_NAME);
    try {
      const st = lstatSync(lp);
      link = st.isSymbolicLink() ? { kind: "symlink", realpath: real(lp) } : { kind: "other", realpath: null };
    } catch {
      link = { kind: "missing", realpath: null };
    }
    const lg = join(projectRoot, LEGACY_DIR);
    legacy = existsSync(join(lg, "trace/records.jsonl")) || existsSync(join(lg, "index.md"));
  }
  const ew = env.LOOP_SETUP_WORKSPACE ? resolve(cwd, env.LOOP_SETUP_WORKSPACE) : null;
  const envWorkspace = ew ? { path: real(ew) || ew, exists: isDir(ew) } : null;
  return { claudeHome, kitRoot: KIT_ROOT, projectRoot, inWorktree, envWorkspace, marker, link, legacy };
}

/** The resolved layout for a cwd/env (the composition of facts + core). */
export function currentLayout(opts = {}) {
  return resolveLayout(gatherFacts(opts));
}

/** A one-line, user-facing description of a layout failure, ending with its hint. */
export function layoutError(layout) {
  return `[layout:${layout.code}] ${layout.message} — ${layout.hint}`;
}
