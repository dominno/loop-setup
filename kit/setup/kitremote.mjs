// The kit's remote — the driven adapter that answers verify-kit's questions about a remote from a
// NEW temporary bare repository: which protected refs (refs/heads/main, refs/tags/kit-v*) it has,
// which of them contain a commit, and the kit tree at that commit. Nothing local is trusted: not
// refs/remotes/*, not a source checkout's objects, grafts, replace refs or commit-graph files.
// Global git config is honoured (the cloud proxy and credentials live there), but a url.insteadOf
// that rewrites the remote to another repository is reported, never followed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote } from "./install.mjs";
import { PROTECTED_REFS, isProtectedRef } from "./integrity.mjs";
import { readKitTree } from "./kittree.mjs";

/** Variables that would point git at another repository or object store than the temporary one. */
const REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE"];

/** The environment git runs in: no repository redirects, no replace objects, never a credential prompt. */
export function gitEnv(env = process.env) {
  const e = { ...env };
  for (const k of REDIRECTS) delete e[k];
  return { ...e, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split("\n").filter(Boolean).pop() || "git failed";

/**
 * The protected-ref facts for `commit` on `remote` (callers pass only a full commit id and a remote
 * that is not an option): { reachable, error?, rewrittenTo?, refs, containing, hasKit, files }.
 */
export function protectedSource({ remote, commit, prefix = "kit", timeoutMs = 120_000, env = process.env }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-setup-verify-"));
  const e = gitEnv(env);
  const run = (args, opts = {}) => execFileSync("git", args, { env: e, input: opts.input, maxBuffer: 1 << 30, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
  const git = (args, opts) => run(["--git-dir", dir, "-c", "protocol.ext.allow=never", "-c", "core.commitGraph=false", ...args], opts);
  try {
    run(["init", "-q", "--bare", dir]);
    const resolved = git(["ls-remote", "--get-url", remote]).toString("utf8").trim();
    if (normalizeRemote(resolved) !== normalizeRemote(remote)) return { reachable: false, rewrittenTo: resolved, refs: [], containing: [], hasKit: false, files: null };
    let refs;
    try {
      const listing = git(["ls-remote", remote, ...PROTECTED_REFS]).toString("utf8");
      refs = [...new Set(listing.split("\n").map((l) => l.split("\t")[1]).filter(isProtectedRef))];
    } catch (err) {
      return { reachable: false, error: firstLine(err), refs: [], containing: [], hasKit: false, files: null };
    }
    if (!refs.length) return { reachable: true, refs, containing: [], hasKit: false, files: null };
    try {
      git(["fetch", "-q", "--no-tags", remote, ...refs.map((r) => `+${r}:refs/protected/${r.slice("refs/".length)}`)]);
    } catch (err) {
      return { reachable: false, error: firstLine(err), refs, containing: [], hasKit: false, files: null };
    }
    let containing = [];
    try {
      containing = git(["for-each-ref", "--format=%(refname)", "--contains", commit, "refs/protected/"])
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((r) => `refs/${r.slice("refs/protected/".length)}`);
    } catch {
      containing = []; // the commit was not fetched: no protected ref reaches it
    }
    if (!containing.length) return { reachable: true, refs, containing, hasKit: false, files: null };
    const files = readKitTree(git, commit, prefix);
    return { reachable: true, refs, containing, hasKit: files.has("kit.json"), files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
