// verify-kit — the use case: is the installed kit exactly what a commit on a protected ref of its
// remote installs? Reads the installed state (the driven adapter for the kit's files, commands and
// settings), asks the remote adapter (kitremote.mjs), and leaves every decision to the pure core
// (integrity.mjs). It checks the kit it runs from, so the code that renders the expected install is
// itself part of the tree being verified (no version skew between verifier and verified).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { loopHome } from "./layout.mjs";
import { manifestPathFor } from "./kitfiles.mjs";
import { compareInstall, expectedInstall, isCommitId, protectedVerdict, redactRemote, settingsEntryCount } from "./integrity.mjs";
import { protectedSource } from "./kitremote.mjs";

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
/** A file's bytes, or null when it is missing or not a regular file. */
const readFile = (p) => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};
/** A settings file: {} when absent, { error } when it does not parse. */
const readSettings = (p) => {
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: e.message };
  }
};
/** Every entry under dir as { rel → Buffer }, with null for anything that is not a regular file (a symlink, a fifo…). */
function readTree(dir) {
  const tree = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (e.isDirectory()) walk(p);
      else tree.set(rel, e.isFile() ? readFileSync(p) : null);
    }
  };
  walk(dir);
  return tree;
}

/**
 * Verify the installed kit at kitRoot (default: the kit this code runs from).
 *   installedShim  where the user's installed shim is (named in the hint when kitRoot is not installed)
 *   projectRoot    the project whose .claude/settings(.local).json also apply (its disableAllHooks counts)
 * → { ok, code: "OK" | "TAMPERED" | "UNVERIFIABLE", commit, remote, protectedBy, problems, checked? }
 */
export function verifyKit({ kitRoot = KIT_ROOT, installedShim = null, projectRoot = null, fetchSource = protectedSource, nodePath = process.execPath } = {}) {
  const loopDir = dirname(kitRoot);
  const claudeHome = dirname(loopDir);
  const manifest = join(loopHome(claudeHome), "kit") === kitRoot ? readJson(manifestPathFor(kitRoot)) : null;
  const { commit = null, remote = null, prefix = null } = manifest?.source || {};
  const shown = typeof remote === "string" ? redactRemote(remote) : null;
  const cannot = (problem) => ({ ok: false, code: "UNVERIFIABLE", commit, remote: shown, protectedBy: [], problems: [problem] });
  if (!manifest) return cannot(`${kitRoot} is not an installed kit (no ${manifestPathFor(kitRoot)}) — verify-kit checks the kit it runs from: run ${installedShim ? `${installedShim} verify-kit` : "the installed loop-setup shim"}`);
  if (!isCommitId(commit)) return cannot(`installed.json: source.commit ${JSON.stringify(commit)} is not a commit id — a kit installed from a directory cannot be verified; reinstall it from a checkout of the kit's repository`);
  if (typeof remote !== "string" || !remote || remote.startsWith("-")) return cannot("installed.json records no usable source.remote — reinstall the kit from a checkout whose origin is the kit's repository");
  if (prefix !== "kit") return cannot(`installed.json: source.prefix ${JSON.stringify(prefix)} — verify-kit anchors only a kit at kit/ of its repository`);

  const src = fetchSource({ remote, commit, prefix });
  const verdict = protectedVerdict(src, { commit, remote });
  if (!verdict.ok) return { ok: false, code: verdict.code, commit, remote: shown, protectedBy: [], problems: verdict.problems };

  const exp = expectedInstall({ files: src.files, claudeHome, nodePath });
  const scopes = projectRoot ? ["settings.json", "settings.local.json"].map((f) => join(projectRoot, ".claude", f)).map((path) => ({ path, settings: readSettings(path) })) : [];
  const observed = {
    manifest,
    tree: readTree(kitRoot),
    commands: new Map([...exp.commands.keys()].map((n) => [n, readFile(join(claudeHome, "commands", `${n}.md`))])),
    settings: readSettings(join(claudeHome, "settings.json")),
    shim: readFile(exp.shim)?.toString("utf8") ?? null,
    scopes,
  };
  const problems = compareInstall(exp, observed);
  return {
    ok: problems.length === 0,
    code: problems.length ? "TAMPERED" : "OK",
    commit,
    remote: shown,
    protectedBy: verdict.protectedBy,
    problems,
    checked: { files: exp.tree.size, commands: exp.commands.size, settings: settingsEntryCount(exp.settingsVariants[0]) },
  };
}
