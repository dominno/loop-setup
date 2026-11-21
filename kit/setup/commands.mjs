// loop-setup lifecycle subcommands (the driving adapter for install/workspace/hooks).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT, claudeHomeOf, currentLayout, gitOut } from "./facts.mjs";
import { LINK_NAME, STATE_BRANCH, loopHome, statePaths } from "./layout.mjs";
import { install, normalizeRemote, uninstall, verifyInstall } from "./install.mjs";
import { runHook } from "./hooks.mjs";
import { init, linkIgnored, linkTracked, originUrl, remoteHasState, restore, sync, syncStatus } from "./workspace.mjs";

const USAGE = `loop-setup — the loop kit, installed in ~/.claude with one workspace per project

  loop-setup install --from <kit repo|kit dir> [--link-bin <dir>] [--auto-restore <host/owner/repo>[,…]]
                     [--with-stop-gate] [--force]      install or upgrade the kit into ~/.claude
  loop-setup uninstall                                 remove what install owns (never a workspace)
  loop-setup init [--from-legacy] [--id <id>]          create this project's workspace and bind it
  loop-setup restore                                   clone the workspace from ${STATE_BRANCH} and bind it
  loop-setup sync [--message <m>] [--no-push] [--force]  commit, merge ${STATE_BRANCH}, lint, push
  loop-setup where [--json]                            show the kit, project and workspace paths
  loop-setup doctor [--json]                           check the install and this project's binding
  loop-setup hook session-start|stop                   (run by Claude Code; never blocks on error)
  loop-setup <trace command> …                         TRACE-lite: write, act, lint, query, … (loop-setup help)`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[k] = true;
      else {
        flags[k] = next;
        i += 1;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const print = (v, json) => process.stdout.write((json || typeof v !== "string" ? JSON.stringify(v, null, 2) : v) + "\n");

/** Everything `where` reports: the three roots and the state paths. */
export function where({ cwd = process.cwd(), env = process.env } = {}) {
  const layout = currentLayout({ cwd, env });
  const claudeHome = claudeHomeOf(env);
  const manifest = verifyInstall(claudeHome).manifest;
  return {
    ok: layout.ok,
    ...(layout.ok ? {} : { code: layout.code, message: layout.message, hint: layout.hint }),
    mode: layout.mode || null,
    kit: { root: KIT_ROOT, installed: manifest ? { version: manifest.kit?.version, commit: manifest.source?.commit, at: join(loopHome(claudeHome), "kit") } : null },
    project: layout.projectRoot,
    workspace: layout.workspace,
    workspaceId: layout.workspaceId,
    inWorktree: layout.inWorktree,
    link: layout.projectRoot ? join(layout.projectRoot, LINK_NAME) : null,
    paths: layout.workspace ? statePaths(layout.workspace) : null,
    warnings: layout.warnings || [],
  };
}

/** Health checks for the install and this project's binding: [{check, ok, detail}] (warn = ok with a note). */
export function doctor({ cwd = process.cwd(), env = process.env } = {}) {
  const claudeHome = claudeHomeOf(env);
  const checks = [];
  const add = (check, ok, detail = "", level = ok ? "ok" : "fail") => checks.push({ check, ok, level, detail });
  const inst = verifyInstall(claudeHome);
  add("kit installed and unmodified", inst.ok, inst.ok ? `${inst.manifest.kit?.version} @ ${inst.manifest.source?.commit?.slice(0, 12) || "(dir)"}` : inst.problems.slice(0, 5).join("; "));
  if (inst.manifest) {
    const settings = (() => {
      try {
        return JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      } catch {
        return {};
      }
    })();
    const has = (event) => (settings.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => String(h.command || "").includes(`hook ${event === "SessionStart" ? "session-start" : "stop"}`)));
    add("SessionStart and Stop hooks registered", has("SessionStart") && has("Stop"));
  }
  const layout = currentLayout({ cwd, env });
  if (!layout.projectRoot) {
    add("inside a git project", false, "not inside a git repository");
    return checks;
  }
  add("workspace resolves", layout.ok, layout.ok ? `${layout.mode}: ${layout.workspace}` : `[${layout.code}] ${layout.hint}`);
  if (!layout.ok || layout.mode === "legacy") {
    if (layout.mode === "legacy") add("migrated out of the repo", false, "state still in .claude/memory — run `loop-setup init --from-legacy`", "warn");
    return checks;
  }
  const lp = join(layout.projectRoot, LINK_NAME);
  if (!layout.inWorktree) add(`${LINK_NAME} link`, !(layout.warnings || []).length, (layout.warnings || []).join(", ") || lp);
  const ignored = linkIgnored(layout.projectRoot);
  add(`${LINK_NAME} is git-ignored`, ignored, ignored ? "" : `add /${LINK_NAME} to .gitignore`);
  add(`${LINK_NAME} is not tracked`, !linkTracked(layout.projectRoot));
  const committedIgnore = (() => {
    try {
      return readFileSync(join(layout.projectRoot, ".gitignore"), "utf8").split("\n").some((l) => l.trim() === `/${LINK_NAME}`);
    } catch {
      return false;
    }
  })();
  add(`.gitignore carries /${LINK_NAME}`, committedIgnore, committedIgnore ? "" : "only the .git/info/exclude backup ignores it", committedIgnore ? "ok" : "warn");
  if (existsSync(join(layout.workspace, ".git"))) {
    const s = syncStatus(layout.workspace);
    add(`workspace synced to ${STATE_BRANCH}`, s.synced, s.hasRemote ? `${s.dirty} changed, ${s.ahead} unpushed` : "no remote configured", s.synced ? "ok" : "warn");
    const remote = originUrl(layout.projectRoot);
    if (remote) {
      const has = remoteHasState(remote);
      add(`remote has ${STATE_BRANCH}`, has === true, has === null ? "remote unreachable" : has ? "" : "run `loop-setup sync` to publish it", has === true ? "ok" : "warn");
      const auto = inst.manifest?.autoRestore || [];
      const norm = normalizeRemote(remote);
      add("auto-restore on session start", auto.includes(norm), auto.includes(norm) ? norm : `install with --auto-restore ${norm} (cloud sessions start empty)`, auto.includes(norm) ? "ok" : "warn");
    }
  } else add("workspace is a git repository", false, "cannot sync — re-create it with init or restore");
  return checks;
}

export async function runLifecycle(cmd, argv) {
  const { pos, flags } = parse(argv);
  const env = process.env;
  const json = !!flags.json;
  try {
    if (cmd === "hook") return runHook(pos[0]);
    if (cmd === "install") {
      if (typeof flags.from !== "string") {
        print(USAGE);
        return 2;
      }
      const m = install({
        from: flags.from,
        claudeHome: claudeHomeOf(env),
        linkBin: typeof flags["link-bin"] === "string" ? flags["link-bin"] : null,
        withStopGate: !!flags["with-stop-gate"],
        autoRestore: typeof flags["auto-restore"] === "string" ? flags["auto-restore"].split(",") : [],
        force: !!flags.force,
      });
      print(json ? m : `installed ${m.kit.name} ${m.kit.version} (${m.source.commit ? m.source.commit.slice(0, 12) : "from a directory"}) into ${join(loopHome(claudeHomeOf(env)), "kit")}\n  commands: ${Object.keys(m.commands).map((c) => `/${c}`).join(" ")}\n  shim: ${m.bin.shim}${m.bin.linked ? ` (linked as ${m.bin.linked})` : ""}\n  auto-restore: ${m.autoRestore.join(", ") || "none"}`, json);
      return 0;
    }
    if (cmd === "uninstall") {
      const r = uninstall({ claudeHome: claudeHomeOf(env) });
      print(json ? r : `uninstalled${r.kept.length ? ` (kept modified: ${r.kept.join(", ")})` : ""}; workspaces kept in ${join(loopHome(claudeHomeOf(env)), "workspaces")}`, json);
      return 0;
    }
    if (cmd === "init") {
      const r = init({ env, fromLegacy: flags["from-legacy"] ? true : undefined, id: typeof flags.id === "string" ? flags.id : undefined });
      print(r, true);
      if (!r.ignored) process.stderr.write(`note: add the line /${LINK_NAME} to .gitignore (the .git/info/exclude block covers this clone only)\n`);
      return 0;
    }
    if (cmd === "restore") {
      print(restore({ env }), true);
      return 0;
    }
    if (cmd === "sync") {
      const r = sync({ env, message: typeof flags.message === "string" ? flags.message : undefined, force: !!flags.force, push: !flags["no-push"] });
      print(r, true);
      return r.ok ? 0 : 1;
    }
    if (cmd === "where") {
      const w = where({ env });
      if (flags.path) print(w.workspace || "");
      else print(w, true);
      return w.ok ? 0 : 2;
    }
    if (cmd === "doctor") {
      const checks = doctor({ env });
      if (json) print(checks, true);
      else print(checks.map((c) => `${c.level === "ok" ? "ok  " : c.level === "warn" ? "warn" : "FAIL"}  ${c.check}${c.detail ? ` — ${c.detail}` : ""}`).join("\n"));
      return checks.some((c) => c.level === "fail") ? 1 : 0;
    }
  } catch (e) {
    process.stderr.write(`loop-setup ${cmd}: ${e.message || e}\n`);
    return 2;
  }
  print(USAGE);
  return 2;
}

export { USAGE, gitOut };
