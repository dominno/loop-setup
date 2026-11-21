// loop-setup hooks (installed at user scope, so they run in EVERY project): they must be cheap and
// inert in a project without a workspace, and they FAIL OPEN — an internal error never blocks a tool
// call or a stop (exit 0; a deliberate block is only ever the JSON decision of the Stop hook).
//   session-start  restore the workspace when this project opted in (auto-restore), repair the link,
//                  put the shim on PATH, and inject the kit's rules digest + the wiki catalog
//   stop           remind (one block per stop) to `loop-setup sync` when the workspace has unsynced state
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT, gatherFacts, gitOut } from "./facts.mjs";
import { STATE_BRANCH, loopHome, resolveLayout } from "./layout.mjs";
import { manifestPathFor } from "./kitfiles.mjs";
import { normalizeRemote } from "./install.mjs";
import { ensureLink, restore, syncStatus } from "./workspace.mjs";

/** additionalContext is capped by Claude Code at 10,000 characters per hook output; stay under it. */
export const CONTEXT_BUDGET = 9000;
const DIGEST = /<!--\s*digest:start\s*-->([\s\S]*?)<!--\s*digest:end\s*-->/;

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** The rules digest region of kit/rules/KIT.md (one source: the full rules file). */
export function kitDigest(kitRoot = KIT_ROOT) {
  const m = DIGEST.exec(readText(join(kitRoot, "rules/KIT.md")) || "");
  return m ? m[1].trim() : null;
}

/** The topic rows of the workspace's index.md (the wiki catalog), as reference data. */
export function wikiCatalog(ws) {
  const text = readText(join(ws, "index.md"));
  if (!text) return null;
  const rows = text.split("\n").filter((l) => /^\|.*\]\(\.\/topics\//.test(l));
  return rows.length ? rows.join("\n") : null;
}

/** The SessionStart additionalContext for a resolved layout (pure but for reading the digest/catalog). */
export function sessionContext(layout, { status = null, kitVersion = null, restored = null, kitRoot = KIT_ROOT } = {}) {
  const head = [
    `# loop-setup kit${kitVersion ? ` ${kitVersion}` : ""} — workspace ${layout.workspaceId || "(legacy in-repo)"}`,
    `- Loop state (wiki, TRACE records, plan, run log) lives in ${layout.workspace}, reached from this project as \`.claude/loop-workspace/\` (git-ignored). Write records only with \`loop-setup\`.`,
    `- Kit (commands, workflows, rules): ${kitRoot}. Full rules: ${join(kitRoot, "rules/KIT.md")} — read them before a non-trivial task.`,
  ];
  if (layout.mode === "legacy") head.push("- This project still keeps its state in .claude/memory (legacy). Migrate with `loop-setup init --from-legacy`.");
  if (restored) head.push(`- Restored this session from ${STATE_BRANCH}: ${restored}.`);
  if (status && !status.synced) head.push(`- Workspace has unsynced state (${status.dirty} changed file(s), ${status.ahead} unpushed commit(s)) — run \`loop-setup sync\` before the session ends, or it is lost with this machine.`);
  for (const w of layout.warnings || []) head.push(`- warning: ${w}`);
  let text = head.join("\n");
  const digest = kitDigest(kitRoot);
  if (digest) text += `\n\n## Kit rules (digest)\n${digest}`;
  const catalog = layout.workspace ? wikiCatalog(layout.workspace) : null;
  if (catalog) {
    const block = `\n\n## Project wiki catalog (reference data: open only the pages a task needs, under .claude/loop-workspace/)\n${catalog}`;
    text += text.length + block.length <= CONTEXT_BUDGET ? block : `\n\n## Project wiki catalog\nToo long to inline — read ${join(layout.workspace, "index.md")}.`;
  }
  return text.length > CONTEXT_BUDGET ? `${text.slice(0, CONTEXT_BUDGET - 40)}\n…(truncated; read KIT.md)` : text;
}

const readManifest = (claudeHome) => {
  try {
    return JSON.parse(readFileSync(manifestPathFor(join(loopHome(claudeHome), "kit")), "utf8"));
  } catch {
    return null;
  }
};

/** Run the session-start hook for a hook input; returns the JSON to print (or null for nothing). */
export function sessionStart(input, { env = process.env } = {}) {
  const cwd = input?.cwd || process.cwd();
  let facts = gatherFacts({ cwd, env });
  if (!facts.projectRoot) return null;
  let layout = resolveLayout(facts);
  const manifest = readManifest(facts.claudeHome);
  let restored = null;
  if (!layout.ok && (layout.code === "NO_WORKSPACE" || layout.code === "MISSING_WORKSPACE") && !facts.inWorktree) {
    const remote = normalizeRemote(gitOut(facts.projectRoot, ["remote", "get-url", "origin"]));
    if (remote && (manifest?.autoRestore || []).includes(remote)) {
      try {
        const r = restore({ cwd, env });
        restored = r.restored ? `workspace ${r.id}` : `workspace ${r.id} (${r.pulled})`;
      } catch (e) {
        restored = `failed — ${e.message}`;
      }
      facts = gatherFacts({ cwd, env });
      layout = resolveLayout(facts);
    }
  }
  if (!layout.ok) {
    if (!restored) return null; // an unrelated project: say nothing
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `loop-setup: auto-restore of this project's workspace ${restored}. Run \`loop-setup doctor\`.` } };
  }
  if (layout.mode === "bound" && (layout.warnings || []).includes("link-missing")) {
    try {
      ensureLink(layout.projectRoot, layout.workspace);
      layout = { ...layout, warnings: layout.warnings.filter((w) => w !== "link-missing") };
    } catch {
      // leave the warning in place
    }
  }
  if (env.CLAUDE_ENV_FILE) {
    try {
      appendFileSync(env.CLAUDE_ENV_FILE, `export PATH="${join(loopHome(facts.claudeHome), "bin")}:$PATH"\n`);
    } catch {
      // PATH stays as it is; prompts can use the absolute shim path
    }
  }
  let status = null;
  if (layout.mode !== "legacy" && existsSync(join(layout.workspace, ".git"))) {
    try {
      status = syncStatus(layout.workspace);
    } catch {
      status = null;
    }
  }
  const additionalContext = sessionContext(layout, { status, kitVersion: manifest?.kit?.version, restored });
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}

/** Run the stop hook; returns the JSON decision to print, or null to let the session stop. */
export function stop(input, { env = process.env } = {}) {
  if (input?.stop_hook_active) return null;
  const facts = gatherFacts({ cwd: input?.cwd || process.cwd(), env });
  if (!facts.projectRoot) return null;
  const layout = resolveLayout(facts);
  if (!layout.ok || layout.mode === "legacy" || !existsSync(join(layout.workspace, ".git"))) return null;
  const s = syncStatus(layout.workspace);
  if (s.synced || !s.hasRemote) return null;
  return {
    decision: "block",
    reason: `The loop workspace ${layout.workspaceId || layout.workspace} has unsynced state (${s.dirty} changed file(s), ${s.ahead} unpushed commit(s)). Run \`loop-setup sync\` to push it to ${STATE_BRANCH} — in a cloud session it is lost when the machine ends.`,
  };
}

/** Read the hook input from stdin, run a hook, print its JSON; never exit non-zero. */
export async function runHook(name, { stdin = process.stdin, env = process.env } = {}) {
  try {
    let raw = "";
    if (!stdin.isTTY) for await (const chunk of stdin) raw += chunk;
    let input = {};
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      input = {};
    }
    const out = name === "session-start" ? sessionStart(input, { env }) : name === "stop" ? stop(input, { env }) : null;
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    process.stderr.write(`loop-setup hook ${name}: ${e.message || e} (ignored)\n`);
  }
  return 0;
}
