// The install contract — the PURE core that says what an install of a kit source puts on disk:
// the rendered kit tree, the registered commands, the shim and the owned settings entries. The
// installer (kit/setup/install.mjs) writes exactly this, and verify-kit (kit/setup/integrity.mjs)
// reproduces it from a protected commit, so the two can never drift apart.
//
// Hexagonal rule: no filesystem, environment, clock or process here. Git is reached only through
// the `git` port a caller passes in (readKitTree); node:path/posix is string handling and
// node:crypto a deterministic hash.
import { createHash } from "node:crypto";
import { posix } from "node:path";

const { join } = posix;

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Kit paths that are development-only: never installed. */
export const DEV_ONLY = (rel) => rel.endsWith(".test.mjs") || rel.startsWith("test/");

/** The standing loop prompt's command name (`/loop 30m /loop-tick`), rendered from loop.md. */
export const LOOP_TICK = "loop-tick";

/** {{KIT}} → the installed kit's absolute path; in a permission rule "({{KIT}}" becomes the absolute "(//…" form. */
export function renderKit(text, kitDir) {
  return String(text).replace(/\(\{\{KIT\}\}/g, `(/${kitDir}`).replace(/\{\{KIT\}\}/g, kitDir);
}

/** The /loop-tick command: the standing loop prompt, run as `/loop 30m /loop-tick`. */
export function loopTickCommand(loopPrompt) {
  return `---\ndescription: loop-setup kit — one iteration of the hardened watchdog loop (run as /loop 30m /loop-tick; declare the trust level first)\nargument-hint: [L1|L2|L3] [focus]\n---\n\n${loopPrompt}`;
}

/** Characters that make a path unsafe to hand to a shell, even quoted (expansion, escapes, control). */
const SHELL_META = /[`$\\;&|<>(){}[\]*?!\x00-\x1f\x7f]/;

/**
 * A path as one shell word, for the hook commands and the shim (both run through a shell). A path
 * with a shell metacharacter is refused with a clear error; with those gone, double quotes are always
 * correct (the plain form), except for a path that holds a double quote: then single quotes, with
 * any single quote written as '\''.
 */
export function shellArg(path) {
  const s = String(path);
  const bad = SHELL_META.exec(s);
  if (bad) throw new Error(`the path ${JSON.stringify(s)} holds the shell metacharacter ${JSON.stringify(bad[0])} — the kit's hook commands and shim run it through a shell; use a Claude home whose path has none of \` $ \\ ; & | < > ( ) { } [ ] * ? ! or control characters`);
  return s.includes('"') ? `'${s.replace(/'/g, "'\\''")}'` : `"${s}"`;
}

/** The shim: absolute node and kit paths, so neither PATH nor the environment can redirect it. */
export function shimText(nodePath, kitDir) {
  return `#!/bin/sh\nexec ${shellArg(nodePath)} ${shellArg(join(kitDir, "bin/loop-setup.mjs"))} "$@"\n`;
}

/** The read-only subcommands the kit allows without a prompt (exact forms, never a blanket grant). */
const READ_ONLY = ["where", "doctor", "verify-kit", "lint", "query", "show", "tree-id", "metrics", "status", "plan-ready", "plan-lint", "plan-items", "plan-drift", "story-lint", "wiki-check", "l3-check", "claim-token"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Why a user's settings cannot take the owned entries, or null when they can: `hooks` and
 * `permissions` must be absent, null or plain objects, every `hooks` event and `permissions.allow` /
 * `permissions.deny` an array. Anything else (an array where an object belongs — JSON drops the
 * entries merged onto it) would lose or corrupt the kit's hooks and rules.
 */
export function settingsShapeProblem(settings) {
  const { hooks, permissions } = settings || {};
  if (hooks != null && !isPlainObject(hooks)) return `hooks is ${Array.isArray(hooks) ? "an array" : typeof hooks}, not an object`;
  for (const [event, groups] of Object.entries(hooks || {})) if (!Array.isArray(groups)) return `hooks.${event} is not an array`;
  if (permissions != null && !isPlainObject(permissions)) return `permissions is ${Array.isArray(permissions) ? "an array" : typeof permissions}, not an object`;
  for (const k of ["allow", "deny"]) if (permissions?.[k] != null && !Array.isArray(permissions[k])) return `permissions.${k} is not an array`;
  return null;
}

/** The lifecycle subcommands that write the Claude home (kit, commands, hooks, settings): a human's step, denied to the agent. */
const LIFECYCLE_WRITES = ["install", "uninstall"];

/**
 * The owned settings entries for a kit at kitDir under loopDir (re-derived on every install; the
 * manifest remembers them). Every path in a hook command goes through shellArg (it throws on an unsafe
 * path). The deny rules keep the kit's own files and the Claude-home lifecycle writes out of the
 * agent's hands — in both spellings of the shim, and for a direct `node …/loop-setup.mjs` run.
 */
export function ownedSettings({ kitDir, loopDir, shim, withStopGate = false, nodePath }) {
  shellArg(kitDir); // the permission rules below embed it too
  const hooks = {
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: `${shellArg(shim)} hook session-start`, timeout: 60 }] }],
    Stop: [{ hooks: [{ type: "command", command: `${shellArg(shim)} hook stop`, timeout: 30 }] }],
  };
  if (withStopGate) hooks.Stop.push({ hooks: [{ type: "command", command: `${shellArg(nodePath)} ${shellArg(join(kitDir, "hooks/stop-gate.mjs"))}`, timeout: 600 }] });
  const allow = [`Read(/${kitDir}/**)`, ...READ_ONLY.flatMap((c) => [`Bash(loop-setup ${c})`, `Bash(loop-setup ${c} *)`])];
  const lifecycle = LIFECYCLE_WRITES.flatMap((c) => [`Bash(loop-setup ${c})`, `Bash(loop-setup ${c} *)`, `Bash(*/loop-setup ${c})`, `Bash(*/loop-setup ${c} *)`]);
  const deny = [`Edit(/${kitDir}/**)`, `Edit(/${join(loopDir, "bin")}/**)`, `Edit(/${join(loopDir, "installed.json")})`, ...lifecycle, "Bash(node *loop-setup.mjs*)"];
  return { hooks, allow, deny };
}

/**
 * What an install of `files` ({ rel → Buffer }, dev-only files already dropped) writes for a kit
 * at kitDir: the kit tree (markdown rendered, everything else byte-for-byte) and the commands
 * registered at user scope (every commands/*.md plus /loop-tick from loop.md), as rendered text.
 */
export function renderInstall(files, kitDir) {
  const tree = new Map();
  const commands = new Map();
  for (const [rel, buf] of files) {
    tree.set(rel, rel.endsWith(".md") ? Buffer.from(renderKit(buf.toString("utf8"), kitDir)) : buf);
    const m = /^commands\/([a-z0-9-]+)\.md$/.exec(rel);
    if (m) commands.set(m[1], renderKit(buf.toString("utf8"), kitDir));
  }
  if (files.has("loop.md")) commands.set(LOOP_TICK, loopTickCommand(renderKit(files.get("loop.md").toString("utf8"), kitDir)));
  return { tree, commands };
}

/**
 * The kit's files at a git revision, as { rel → Buffer } (dev-only files dropped), read through
 * the `git` port: git(args, { input? }) → Buffer (stdout). One ls-tree and one cat-file --batch,
 * so a tree of any size costs two git processes. Only regular blobs count (no symlinks or gitlinks).
 */
export function readKitTree(git, rev, prefix) {
  const base = prefix ? `${prefix}/` : "";
  const entries = [];
  for (const row of git(["ls-tree", "-r", "-z", rev, "--", prefix || "."]).toString("utf8").split("\0")) {
    const m = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (!m) continue;
    const rel = m[3].slice(base.length);
    if (!DEV_ONLY(rel)) entries.push({ id: m[2], rel });
  }
  const files = new Map();
  if (!entries.length) return files;
  const out = git(["cat-file", "--batch"], { input: `${entries.map((e) => e.id).join("\n")}\n` });
  let at = 0;
  for (const { id, rel } of entries) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString("utf8");
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
    if (!header.startsWith(`${id} blob `) || !Number.isInteger(size)) throw new Error(`git cat-file: unexpected header ${JSON.stringify(header)} for ${rel}`);
    files.set(rel, Buffer.from(out.subarray(nl + 1, nl + 1 + size)));
    at = nl + 1 + size + 1;
  }
  return files;
}
