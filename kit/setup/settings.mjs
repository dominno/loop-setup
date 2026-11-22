// Claude Code settings files — the driven adapter that reads every settings scope that applies
// (managed policy, the project's local and shared settings, the user's) for the sandbox core
// (kit/setup/sandbox.mjs), and one settings file for verify-kit.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A settings file: null only when it does not exist; the parsed object; or { error } — for a file
 * that cannot be read (EACCES, a directory at the path), does not parse, or is not a JSON object.
 * Callers fail closed on { error }: an unreadable policy is never read as "no settings".
 */
export function readSettingsFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? null : { error: `cannot be read (${e.code || e.message})` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: e.message };
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : { error: "not a JSON object" };
}

/** Where this machine's managed (policy) settings live. */
export function managedSettingsDir(platform = process.platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * The settings sources in Claude Code's precedence order — managed (managed-settings.d/*.json, the
 * last name first, then managed-settings.json; only the files that exist), the project's
 * .claude/settings.local.json and .claude/settings.json (when there is a project), the user's
 * settings.json — as [{ scope, path, settings }]. The managed directory has no environment
 * override: it is policy, and an override would let anyone stand in for it.
 */
export function settingsSources({ claudeHome, projectRoot = null, managedDir = managedSettingsDir() }) {
  const sources = [];
  const dropIns = join(managedDir, "managed-settings.d");
  let names = [];
  try {
    names = readdirSync(dropIns).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    names = [];
  }
  for (const path of [...names.map((f) => join(dropIns, f)), join(managedDir, "managed-settings.json")]) {
    const settings = readSettingsFile(path);
    if (settings !== null) sources.push({ scope: "managed", path, settings });
  }
  if (projectRoot) {
    for (const [scope, file] of [["local", "settings.local.json"], ["project", "settings.json"]]) {
      const path = join(projectRoot, ".claude", file);
      sources.push({ scope, path, settings: readSettingsFile(path) });
    }
  }
  const user = join(claudeHome, "settings.json");
  sources.push({ scope: "user", path: user, settings: readSettingsFile(user) });
  return sources;
}
