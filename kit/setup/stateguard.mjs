// The state-repo guard — the PURE core that decides whether git may run on a workspace's state
// repository (phase C, goal C3). A workspace is writable by every session, so anything git reads
// from it, or from the state git dir, could name a command git runs during status, add, commit,
// fetch, merge or push: a filter or merge driver in attributes, a key in the repository's config, a
// file in the git dir that pulls in more config. The adapter (workspace.mjs) gathers the facts; this
// module only decides. Hashing is computation, not I/O.
import { createHash } from "node:crypto";

/** Where the template lives in the kit (named in the fix a refusal suggests). */
export const TEMPLATE_PATH = "kit/templates/workspace/.gitattributes";
/**
 * The sha256 of every released kit/templates/workspace/.gitattributes. A template edit ADDS its
 * digest (stateguard.test.mjs pins the current one in), so a workspace made by an older kit, and a
 * machine still running one, are never refused for it.
 */
export const TEMPLATE_ATTRIBUTES_SHA256 = ["6024a1750b7e565999ecee022655a02f955dd0e0bccacf72f349bb7dd958a639"];
/** Git dir entries git follows to more config, attributes or objects. The kit writes none of them. */
export const GITDIR_ENTRIES = ["commondir", "gitdir", "config.worktree", "info/attributes", "objects/info/alternates", "objects/info/http-alternates", "worktrees", "modules"];
/**
 * The state repo's config keys, exactly as `git config --list` prints them (section and key
 * lowercased): what `git init`, `git remote add` and `git clone --single-branch` write for it, plus
 * the platform keys git init sets on some file systems. Anything else is refused: an allowlist
 * covers every key that names a command (filter.*, diff.*.textconv, merge.*.driver, the core.* hook
 * settings, diff.external, gpg.*, credential.*, include*, protocol.*, …) without listing them.
 */
export const ALLOWED_CONFIG = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "extensions.objectformat",
  "remote.origin.url",
  "remote.origin.fetch",
  "branch.claude/loop-state.remote",
  "branch.claude/loop-state.merge",
]);
export const allowedConfigKey = (key) => ALLOWED_CONFIG.has(String(key));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isNamed = (name) => (path) => path === name || path.endsWith(`/${name}`);

function rootAttributesRefusal(content) {
  if (content === null || content === undefined) return { cause: `.gitattributes is missing — put the kit template back (${TEMPLATE_PATH})` };
  if (!TEMPLATE_ATTRIBUTES_SHA256.includes(sha256(content))) return { cause: `.gitattributes differs from the kit template (${TEMPLATE_PATH}): planted attributes can make git run a filter or a merge driver — put the template back` };
  return null;
}

/** Rules 1–3 over a list of paths: the root .gitattributes, any other one, any .gitmodules. */
function treeRefusal(paths, rootAttributes) {
  const root = rootAttributesRefusal(paths.includes(".gitattributes") ? rootAttributes : null);
  if (root) return root;
  const nested = paths.find((p) => p !== ".gitattributes" && isNamed(".gitattributes")(p));
  if (nested) return { cause: `${nested}: only the root .gitattributes (the kit template) is allowed in a workspace — remove it` };
  const modules = paths.find(isNamed(".gitmodules"));
  if (modules) return { cause: `${modules}: a workspace has no submodules — remove it` };
  return null;
}

/**
 * May git run on this state repo? facts:
 *   attributes     [{ path, content }] every .gitattributes in the work tree (path relative to it)
 *   gitmodules     [path] every .gitmodules in the work tree
 *   config         [[key, value]] the state repo's own config file (`git config --file … -z --list`)
 *   gitDirEntries  [entry] the GITDIR_ENTRIES that exist in the state git dir
 * → null, or { cause } for the first refusal (attributes, modules, git dir entries, config).
 */
export function stateRepoRefusal({ attributes = [], gitmodules = [], config = [], gitDirEntries = [] }) {
  const root = attributes.find((a) => a.path === ".gitattributes");
  const tree = treeRefusal([...attributes.map((a) => a.path), ...gitmodules], root ? root.content : null);
  if (tree) return tree;
  const entry = gitDirEntries.find((e) => GITDIR_ENTRIES.includes(e));
  if (entry) return { cause: `${entry} in the state git dir: git would follow it to more config, attributes or objects, and the kit never writes one — remove it` };
  const key = config.map(([k]) => k).find((k) => !allowedConfigKey(k));
  if (key) return { cause: `the state repo's config sets ${key}, which git never writes for it — a planted key can make git run a command; remove it (git config --file <state git dir>/config --unset-all ${key})` };
  return null;
}

/** May a commit's tree reach the work tree? paths = `git ls-tree -r --name-only`, rootAttributes = its .gitattributes or null. */
export function incomingTreeRefusal({ paths = [], rootAttributes = null }) {
  return treeRefusal(paths, rootAttributes);
}
