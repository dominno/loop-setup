// Kit integrity — the PURE core of `loop-setup verify-kit`: is the installed kit exactly what a
// commit on a protected ref of the kit's remote installs, and may an L1/L2/L3 dispatch go on?
//
// Hexagonal rule: no filesystem, git, environment, clock or network here. The facts come from the
// driven adapters (kit/setup/kitremote.mjs: the remote, read in a fresh temporary repository;
// kit/setup/verifykit.mjs: the installed files); the CLI is the driving adapter.
import { posix } from "node:path";
import { ownedSettings, renderInstall, sha256, shimText } from "./kittree.mjs";
import { loopHome } from "./layout.mjs";

const { join } = posix;

/** The refs of the kit's remote that anchor an install: its main branch and its kit-v* release tags. */
export const PROTECTED_REFS = ["refs/heads/main", "refs/tags/kit-v*"];
/** True for a protected ref name as `git ls-remote` prints it (never a peeled `^{}` line). */
export const isProtectedRef = (ref) => ref === "refs/heads/main" || /^refs\/tags\/kit-v[^/^]+$/.test(String(ref));

/** A full commit id (sha1 or sha256) — the only form of a commit that ever reaches git. */
export const isCommitId = (s) => typeof s === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s);

/**
 * A remote URL with no credential left in it, as installed.json records it and verify-kit prints it:
 * an http(s) URL loses all its userinfo (a token can be the user name; git's credential helper
 * supplies what the remote needs), any other URL loses a password (an ssh user name stays: ssh needs it).
 */
export const redactRemote = (url) =>
  String(url)
    .replace(/^(https?:\/\/)[^@/]*@/i, "$1")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]*):[^@/]*@/i, "$1@");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Everything an install of `files` (the kit tree at the protected commit) under claudeHome puts
 * on disk, through the installer's own contract (kittree.mjs). nodePath is the node the shim and
 * the stop gate must pin: the caller passes the running verify-kit's own node, never one read back
 * from the installed files. The owned settings come in both variants (without and with the opt-in
 * stop gate); which one applies is read from installed.json — unanchored, and the gate is advisory.
 */
export function expectedInstall({ files, claudeHome, nodePath }) {
  const loopDir = loopHome(claudeHome);
  const kitDir = join(loopDir, "kit");
  const shim = join(loopDir, "bin", "loop-setup");
  const { tree, commands } = renderInstall(files, kitDir);
  let kitVersion = null;
  try {
    kitVersion = JSON.parse(files.get("kit.json").toString("utf8")).version ?? null;
  } catch {
    kitVersion = null;
  }
  const settingsVariants = [false, true].map((withStopGate) => ownedSettings({ kitDir, loopDir, shim, withStopGate, nodePath }));
  return { kitDir, loopDir, shim, tree, commands, shimText: shimText(nodePath, kitDir), settingsVariants, kitVersion };
}

/** The number of owned settings entries in a variant (hook groups + permission rules). */
export const settingsEntryCount = (owned) => Object.values(owned.hooks).reduce((n, groups) => n + groups.length, 0) + owned.allow.length + owned.deny.length;

/**
 * The differences between the expected install and what is on disk, each naming the tamper.
 * observed = { manifest, tree: Map<rel, Buffer|null (not a regular file)>, commands: Map<name, Buffer|null (missing)>,
 *              settings: object | { error }, shim: string|null,
 *              scopes?: [{ path, settings }] (other settings files that apply, e.g. the project's) }
 * Extra hooks and allow rules are the user's own and are not examined (hooks add up, deny beats
 * allow); disableAllHooks, which silently switches the owned hooks off, is.
 */
export function compareInstall(exp, observed) {
  const problems = [];
  const m = observed.manifest || {};

  // Every installed kit file, byte for byte; anything the commit does not install is a tamper too.
  for (const [rel, want] of exp.tree) {
    if (!observed.tree.has(rel)) problems.push(`missing kit/${rel}`);
    else if (observed.tree.get(rel) === null) problems.push(`not a regular file kit/${rel}`);
    else if (!observed.tree.get(rel).equals(want)) problems.push(`modified kit/${rel}`);
  }
  for (const rel of observed.tree.keys()) if (!exp.tree.has(rel)) problems.push(`unexpected kit/${rel} (the commit does not install it)`);

  // installed.json is checked against the commit, never trusted: its hashes, owned settings and version.
  const manifestMap = (key, want, noun) => {
    const have = m[key] || {};
    for (const [k, hash] of Object.entries(have)) {
      if (!want.has(k)) problems.push(`installed.json: ${key}["${k}"] lists a ${noun} the commit does not install`);
      else if (hash !== want.get(k)) problems.push(`installed.json: ${key}["${k}"] is not the sha256 the commit installs`);
    }
    for (const k of want.keys()) if (!(k in have)) problems.push(`installed.json: ${key} lacks "${k}"`);
  };
  manifestMap("files", new Map([...exp.tree].map(([rel, buf]) => [rel, sha256(buf)])), "file");
  manifestMap("commands", new Map([...exp.commands].map(([n, text]) => [n, sha256(Buffer.from(text))])), "command");
  const variant = exp.settingsVariants.find((v) => same(v, m.settings));
  if (!variant) problems.push("installed.json: owned settings differ from what the commit installs");
  if ((m.kit?.version ?? null) !== exp.kitVersion) problems.push(`installed.json: kit version ${m.kit?.version ?? "(none)"} is not the commit's ${exp.kitVersion}`);

  // Every registered command.
  for (const [name, text] of exp.commands) {
    const have = observed.commands.get(name);
    const where = `(~/.claude/commands/${name}.md)`;
    if (have == null) problems.push(`command /${name} missing ${where}`);
    else if (!have.equals(Buffer.from(text))) problems.push(`command /${name} modified ${where}`);
  }

  // Every owned settings.json entry (the variant installed.json records, else the minimal one).
  const s = observed.settings || {};
  if (s.error) problems.push(`settings.json does not parse (${s.error})`);
  else {
    const owned = variant || exp.settingsVariants[0];
    for (const [event, groups] of Object.entries(owned.hooks)) {
      for (const group of groups) {
        if (!(s.hooks?.[event] || []).some((g) => same(g, group))) problems.push(`settings.json: owned ${event} hook (\`${group.hooks.map((h) => h.command).join(" && ")}\`) missing or changed`);
      }
    }
    for (const k of ["allow", "deny"]) {
      for (const rule of owned[k]) if (!(s.permissions?.[k] || []).includes(rule)) problems.push(`settings.json: owned permissions.${k} rule "${rule}" missing`);
    }
  }
  for (const { path, settings } of [{ path: "settings.json", settings: s }, ...(observed.scopes || [])]) {
    if (settings?.disableAllHooks === true) problems.push(`${path}: disableAllHooks is true — the kit's owned hooks never run`);
  }

  // The shim every hook and command runs through.
  if (observed.shim == null) problems.push(`shim ${exp.shim} missing`);
  else if (observed.shim !== exp.shimText) problems.push(`shim ${exp.shim} does not run the installed kit`);
  return problems;
}

/**
 * The protected-ref decision from the remote's facts:
 *   facts = { reachable, error?, rewrittenTo?, refs: [protected refs the remote has], containing: [those that contain commit], hasKit }
 * → { ok: true, protectedBy } | { ok: false, code: "UNVERIFIABLE" | "TAMPERED", problems }.
 */
export function protectedVerdict(facts, { commit, remote }) {
  const shown = redactRemote(remote);
  const no = (code, problem) => ({ ok: false, code, problems: [problem] });
  if (facts.rewrittenTo) return no("UNVERIFIABLE", `git config rewrites the remote ${shown} to ${redactRemote(facts.rewrittenTo)} (url.*.insteadOf) — refusing to verify against another repository`);
  if (!facts.reachable) return no("UNVERIFIABLE", `remote ${shown} unreachable: ${facts.error || "no answer"} — cannot verify the kit (fail closed)`);
  if (!facts.refs?.length) return no("UNVERIFIABLE", `remote ${shown} has none of ${PROTECTED_REFS.join(", ")} — nothing to anchor the kit to`);
  if (!facts.containing?.length) return no("TAMPERED", `installed.json: source.commit ${commit.slice(0, 12)} is not on a protected ref of ${shown} (${PROTECTED_REFS.join(", ")})`);
  if (!facts.hasKit) return no("TAMPERED", `installed.json: source.commit ${commit.slice(0, 12)} has no kit/kit.json — it is not the commit the kit was installed from`);
  return { ok: true, protectedBy: facts.containing };
}

/** The trust level of a dispatch command's --level flag: "L1" | "L2" | "L3", or null when not given. */
export function parseLevel(value) {
  if (value === undefined) return null;
  if (typeof value === "string" && /^l[123]$/i.test(value)) return value.toUpperCase();
  throw new Error(`--level must be L1, L2 or L3 (got ${JSON.stringify(value)})`);
}

/**
 * The kit integrity gate of the L2/L3 dispatch commands: a verified kit passes; otherwise L1 only
 * warns, and L2, L3 or an undeclared level (fail closed: these commands are dispatch steps) refuse.
 * → { allow, message: null | "warning: …" | "error: …" }
 */
export function kitGate(level, result) {
  if (result.ok) return { allow: true, message: null };
  const ps = result.problems || [];
  const why = `kit integrity not verified (loop-setup verify-kit): ${ps.slice(0, 3).join("; ")}${ps.length > 3 ? `; … ${ps.length - 3} more` : ""}`;
  if (level === "L1") return { allow: true, message: `warning: ${why} — continuing at L1 (report only)` };
  return { allow: false, message: `error: ${why} — refusing at ${level || "no --level declared (fail closed: run it with --level L1|L2|L3)"}` };
}
