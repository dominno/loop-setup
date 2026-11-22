// loop-setup install / uninstall — puts the kit into the Claude config dir (~/.claude):
//   <home>/loop-setup/kit/          the kit's files, copied from a COMMITTED source (git HEAD of the
//                                   source repo) or a kit directory, with {{KIT}} rendered in prompts
//   <home>/loop-setup/installed.json every installed file's sha256, the owned commands and settings, and the
//                                   source (commit, remote, kit prefix) that `loop-setup verify-kit` anchors to
//   <home>/loop-setup/bin/loop-setup the shim (absolute node + kit paths baked in)
//   <home>/commands/<name>.md       the kit's commands (user scope: bare /names in every project)
//   <home>/settings.json            owned hooks (SessionStart, Stop) and permission rules, merged
// Uninstall removes exactly what the manifest says it owns (unchanged files only) and never
// touches a workspace.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loopHome } from "./layout.mjs";
import { manifestPathFor } from "./kitfiles.mjs";
import { redactRemote } from "./integrity.mjs";
import { DEV_ONLY, ownedSettings as ownedSettingsFor, readKitTree, renderInstall, sha256, shimText } from "./kittree.mjs";

// The install contract (renderKit, loopTickCommand, the owned settings) lives in the pure kittree.mjs,
// shared with verify-kit; it is re-exported here for existing callers.
export { loopTickCommand, renderKit } from "./kittree.mjs";

export const MANIFEST_SCHEMA = 1;

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

/**
 * The kit's files as { rel → Buffer }, from `from`:
 *  - a git checkout whose HEAD has kit/kit.json: the committed tree (never the working tree), its
 *    commit, its kit prefix and its origin remote (password stripped; null without one);
 *  - otherwise a directory holding kit.json (an unpacked kit): its files, commit, prefix and remote null.
 */
export function readKitSource(from) {
  const src = resolve(from);
  const git = (args, opts = {}) => execFileSync("git", args, { cwd: src, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], ...opts });
  let top = null;
  try {
    top = git(["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    top = null;
  }
  if (top) {
    let prefix = null;
    for (const cand of ["kit", relative(realpathSync(top), realpathSync(src)).split(sep).join("/")]) {
      try {
        git(["cat-file", "-e", `HEAD:${cand ? `${cand}/` : ""}kit.json`]);
        prefix = cand;
        break;
      } catch {
        // not here
      }
    }
    if (prefix !== null) {
      const commit = git(["rev-parse", "HEAD"], { encoding: "utf8", cwd: top }).trim();
      const files = readKitTree((args, opts = {}) => git(args, { cwd: top, input: opts.input, stdio: ["pipe", "pipe", "ignore"] }), commit, prefix);
      let remote = null;
      try {
        remote = redactRemote(git(["remote", "get-url", "origin"], { encoding: "utf8", cwd: top }).trim()) || null;
      } catch {
        remote = null;
      }
      return { files, commit, prefix, remote, from: top };
    }
  }
  if (!existsSync(join(src, "kit.json"))) throw new Error(`${src} is neither a git checkout with a committed kit/ nor a kit directory (no kit.json)`);
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(src, p).split(sep).join("/");
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !DEV_ONLY(rel)) files.set(rel, readFileSync(p));
    }
  };
  walk(src);
  return { files, commit: null, prefix: null, remote: null, from: src };
}

/** The owned settings entries for a kit at kitDir under loopDir (re-derived on every install; the manifest remembers them). */
export function ownedSettings({ kitDir, loopDir, shim, withStopGate = false, nodePath = process.execPath }) {
  return ownedSettingsFor({ kitDir, loopDir, shim, withStopGate, nodePath });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** settings minus the entries an earlier install owned (as recorded), plus `owned`. Pure. */
export function mergeSettings(settings, owned, previous = null) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  const drop = (list, olds) => (list || []).filter((x) => !(olds || []).some((o) => same(o, x)));
  if (previous) {
    for (const [event, groups] of Object.entries(previous.hooks || {})) {
      if (!out.hooks?.[event]) continue;
      out.hooks[event] = drop(out.hooks[event], groups);
      if (!out.hooks[event].length) delete out.hooks[event];
    }
    if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
    if (out.permissions) {
      for (const k of ["allow", "deny"]) {
        if (out.permissions[k]) out.permissions[k] = drop(out.permissions[k], previous[k]);
      }
    }
  }
  if (owned) {
    out.hooks = out.hooks || {};
    for (const [event, groups] of Object.entries(owned.hooks)) out.hooks[event] = [...(out.hooks[event] || []).filter((g) => !groups.some((o) => same(o, g))), ...groups];
    out.permissions = out.permissions || {};
    for (const k of ["allow", "deny"]) out.permissions[k] = [...(out.permissions[k] || []).filter((x) => !owned[k].includes(x)), ...owned[k]];
  }
  if (out.permissions) {
    for (const k of ["allow", "deny"]) if (out.permissions[k] && !out.permissions[k].length) delete out.permissions[k];
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  return out;
}

/**
 * The user's settings.json: {} only when the file does not exist. A file that exists but does not
 * parse is the user's data — refuse (nothing is changed) instead of replacing it with the kit's entries.
 */
export function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} does not parse as JSON (${e.message}) — fix it first; loop-setup changed nothing`);
  }
}

/**
 * Write a settings file through a symlink to its target (a dotfiles setup). The FIRST original is
 * kept as <file>.loop-setup.bak and never overwritten, so a later install or uninstall cannot
 * replace the user's original with a kit-written copy.
 */
function writeSettings(path, value) {
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
  } catch {
    // no file yet
  }
  const bak = `${target}.loop-setup.bak`;
  if (existsSync(target) && !existsSync(bak)) writeFileSync(bak, readFileSync(target));
  writeJson(target, value);
}

/**
 * Install (or upgrade in place) the kit from `from` into claudeHome. Idempotent.
 * opts: { from, claudeHome, linkBin?, withStopGate?, autoRestore?: string[], force?, now? }
 */
export function install({ from, claudeHome, linkBin = null, withStopGate = false, autoRestore = [], force = false, now = new Date().toISOString() }) {
  const loopDir = loopHome(claudeHome);
  const kitDir = join(loopDir, "kit");
  const manifestPath = manifestPathFor(kitDir);
  const previous = readJson(manifestPath, null);
  const { files, commit, prefix, remote, from: source } = readKitSource(from);
  const { tree, commands } = renderInstall(files, kitDir);
  const kitJson = JSON.parse(files.get("kit.json").toString("utf8"));
  // Read the user's settings first: one that does not parse stops the install before anything changes.
  const settingsPath = join(claudeHome, "settings.json");
  const userSettings = readSettings(settingsPath);

  // Commands first, so a clash stops the install before anything changes.
  const commandsDir = join(claudeHome, "commands");
  const clashes = [];
  for (const name of commands.keys()) {
    const p = join(commandsDir, `${name}.md`);
    if (!existsSync(p)) continue;
    const owned = previous?.commands?.[name];
    const current = sha256(readFileSync(p));
    if (owned !== current) clashes.push(`${name}.md`);
  }
  if (clashes.length && !force) {
    throw new Error(`~/.claude/commands already has ${clashes.join(", ")} that the kit did not install (or that changed since) — move them away or pass --force (a .bak copy is kept)`);
  }

  // The kit tree: staged, then swapped in.
  const stage = `${kitDir}.new`;
  rmSync(stage, { recursive: true, force: true });
  const fileHashes = {};
  for (const [rel, out] of tree) {
    const p = join(stage, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out);
    if (rel.startsWith("bin/")) chmodSync(p, 0o755);
    fileHashes[rel] = sha256(out);
  }
  if (existsSync(kitDir)) {
    const old = `${kitDir}.old`;
    rmSync(old, { recursive: true, force: true });
    renameSync(kitDir, old);
    renameSync(stage, kitDir);
    rmSync(old, { recursive: true, force: true });
  } else {
    mkdirSync(loopDir, { recursive: true });
    renameSync(stage, kitDir);
  }

  // Commands.
  mkdirSync(commandsDir, { recursive: true });
  const commandHashes = {};
  for (const [name, text] of commands) {
    const p = join(commandsDir, `${name}.md`);
    if (clashes.includes(`${name}.md`)) writeFileSync(`${p}.bak`, readFileSync(p));
    writeFileSync(p, text);
    commandHashes[name] = sha256(Buffer.from(text));
  }
  for (const [name, hash] of Object.entries(previous?.commands || {})) {
    const p = join(commandsDir, `${name}.md`);
    if (!commands.has(name) && existsSync(p) && sha256(readFileSync(p)) === hash) rmSync(p);
  }

  // Shim: absolute node and kit paths, so neither PATH nor the environment can redirect it.
  const shim = join(loopDir, "bin", "loop-setup");
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, shimText(process.execPath, kitDir));
  chmodSync(shim, 0o755);
  let linked = null;
  if (linkBin) {
    const link = join(resolve(linkBin), "loop-setup");
    mkdirSync(dirname(link), { recursive: true });
    let mine = false;
    try {
      mine = lstatSync(link).isSymbolicLink() && readlinkSync(link) === shim;
      if (!mine) throw new Error(`${link} exists and is not the loop-setup shim — remove it or pick another --link-bin`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!mine) symlinkSync(shim, link);
    linked = link;
  }

  // Settings.
  const owned = ownedSettings({ kitDir, loopDir, shim, withStopGate });
  writeSettings(settingsPath, mergeSettings(userSettings, owned, previous?.settings || null));

  const manifest = {
    schema: MANIFEST_SCHEMA,
    kit: { name: kitJson.name, version: kitJson.version },
    source: { from: source, commit, remote, prefix },
    installedAt: now,
    files: fileHashes,
    commands: commandHashes,
    settings: owned,
    bin: { shim, linked },
    autoRestore: [...new Set([...(previous?.autoRestore || []), ...autoRestore.map(normalizeRemote).filter(Boolean)])],
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

/** Remove what the manifest owns (unchanged files only); workspaces are never touched. */
export function uninstall({ claudeHome }) {
  const loopDir = loopHome(claudeHome);
  const kitDir = join(loopDir, "kit");
  const manifestPath = manifestPathFor(kitDir);
  const manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error(`the kit is not installed in ${claudeHome} (no ${manifestPath})`);
  const settingsPath = join(claudeHome, "settings.json");
  const userSettings = readSettings(settingsPath); // refuses before anything is removed
  const kept = [];
  for (const [name, hash] of Object.entries(manifest.commands || {})) {
    const p = join(claudeHome, "commands", `${name}.md`);
    if (!existsSync(p)) continue;
    if (sha256(readFileSync(p)) === hash) rmSync(p);
    else kept.push(p);
  }
  if (existsSync(settingsPath)) writeSettings(settingsPath, mergeSettings(userSettings, null, manifest.settings));
  if (manifest.bin?.linked) {
    try {
      if (lstatSync(manifest.bin.linked).isSymbolicLink()) unlinkSync(manifest.bin.linked);
    } catch {
      // already gone
    }
  }
  rmSync(join(loopDir, "bin"), { recursive: true, force: true });
  rmSync(kitDir, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
  return { kept };
}

/** A remote URL as host/owner/repo (ssh and https unified, no .git, no credentials, lowercase). */
export function normalizeRemote(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  // A local repository (tests, a mirror on disk): its absolute path, case kept.
  if (s.startsWith("/") || s.startsWith("file://")) return `file:${s.replace(/^file:\/\//, "").replace(/\/+$/, "").replace(/\.git$/, "")}`;
  let m = /^[\w.-]+@([^:]+):(.+)$/.exec(s); // git@host:owner/repo
  let host;
  let path;
  if (m) [, host, path] = m;
  else {
    m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s);
    if (m) [, host, path] = m;
    else {
      [host, ...path] = s.split("/");
      path = path.join("/");
    }
  }
  path = String(path || "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
  // A local git proxy (cloud sessions) spells the remote http://…@127.0.0.1:port/git/<owner>/<repo>.
  path = path.replace(/^git\//, "");
  return host && path ? `${host}/${path}`.toLowerCase() : null;
}

/** True when the kit's install manifest exists and every installed file still has its recorded hash. */
export function verifyInstall(claudeHome) {
  const kitDir = join(loopHome(claudeHome), "kit");
  const manifest = readJson(manifestPathFor(kitDir), null);
  if (!manifest) return { ok: false, problems: ["not installed"], manifest: null };
  const problems = [];
  for (const [rel, hash] of Object.entries(manifest.files || {})) {
    const p = join(kitDir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) problems.push(`missing ${rel}`);
    else if (sha256(readFileSync(p)) !== hash) problems.push(`modified ${rel}`);
  }
  for (const [name, hash] of Object.entries(manifest.commands || {})) {
    const p = join(claudeHome, "commands", `${name}.md`);
    if (!existsSync(p)) problems.push(`command /${name} missing`);
    else if (sha256(readFileSync(p)) !== hash) problems.push(`command /${name} modified`);
  }
  return { ok: problems.length === 0, problems, manifest };
}
