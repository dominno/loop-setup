// Permission and hook gates for the committed .claude/settings.json and for the commands'
// allowed-tools. Portable: an adopter who copies scripts/trace/ keeps these checks, and the
// settings checks skip while the project has no .claude/settings.json.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const SETTINGS = join(ROOT, ".claude/settings.json");
const settings = () => JSON.parse(readFileSync(SETTINGS, "utf8"));

// Approximates Claude Code's documented Bash rule matching (code.claude.com/docs/en/permissions,
// "Wildcard patterns"): a trailing ':*' is the same as ' *'; '*' matches any text, spaces
// included; and a trailing ' *' that is the rule's only wildcard also matches the bare command.
// A bare tool name (or tool-name glob such as '*') covers every call to the tool. Compound
// commands and wrappers are not modelled: every command below is a single plain invocation.
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const globRe = (glob) => new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$", "s");
function coversBash(rule, command) {
  const m = /^([^(]*)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  const [, tool, spec] = m;
  if (spec === undefined) return globRe(tool).test("Bash");
  if (tool !== "Bash") return false;
  const pattern = spec.replace(/:\*$/, " *");
  if (globRe(pattern).test(command)) return true;
  return pattern.indexOf("*") === pattern.length - 1 && pattern.endsWith(" *") && command === pattern.slice(0, -2);
}
const deniedBy = (command) => (settings().permissions?.deny ?? []).filter((rule) => coversBash(rule, command));

describe("Bash rule matcher", () => {
  // Rows from the documented examples, plus the two spellings this repo relies on.
  it.each([
    ["Bash(npm run build)", "npm run build", true],
    ["Bash(npm run build)", "npm run build --watch", false],
    ["Bash(npm run *)", "npm run test --watch", true],
    ["Bash(npm run *)", "npm run", true],
    ["Bash(npm run *)", "npm install", false],
    ["Bash(git log * main)", "git log --oneline main", true],
    ["Bash(git log * main)", "git log main", false],
    ["Bash(ls *)", "lsof", false],
    ["Bash(ls*)", "lsof", true],
    ["Bash(* --help *)", "npm --help x", true],
    ["Bash(* --help *)", "npm --help", false],
    ["Bash(ls:*)", "ls", true],
    ["Bash(pnpm test:*)", "pnpm test:e2e", false],
    ["Bash", "git push", true],
  ])("%s on %j → %s", (rule, command, expected) => {
    expect(coversBash(rule, command)).toBe(expected);
  });
});

describe.skipIf(!existsSync(SETTINGS))(".claude/settings.json", () => {
  it("parses as JSON", () => {
    expect(() => settings()).not.toThrow();
  });

  it("never denies a plain push (no allow rule can override a deny, and loops and commits must still push)", () => {
    const plain = ["git push", "git push -u origin claude/x", "git push origin HEAD", "git push --set-upstream origin x"];
    expect(plain.filter((c) => deniedBy(c).length)).toEqual([]);
  });

  it("denies the force-push forms", () => {
    const forced = ["git push --force origin x", "git push origin x --force-with-lease", "git push -f", "git push origin main -f", "git push origin -f main", "git push origin +main"];
    expect(forced.filter((c) => !deniedBy(c).length)).toEqual([]);
  });

  it("denies a hard reset and nothing softer", () => {
    expect(["git reset --hard", "git reset -q --hard HEAD~1"].filter((c) => !deniedBy(c).length)).toEqual([]);
    expect(["git reset --soft HEAD~1", "git reset HEAD src/a.ts"].filter((c) => deniedBy(c).length)).toEqual([]);
  });

  it("adds no tool-event hook, and every hook runs an existing .claude/hooks/ script with a timeout of at most 120 s", () => {
    const hooks = settings().hooks ?? {};
    // Tool events fire inside every workflow subagent, the measured loop verifier included.
    const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"];
    expect(Object.keys(hooks).filter((event) => TOOL_EVENTS.includes(event))).toEqual([]);
    const bad = [];
    for (const [event, groups] of Object.entries(hooks))
      for (const group of groups ?? [])
        for (const hook of group.hooks ?? []) {
          const script = /\.claude\/hooks\/[^\s"'`]+/.exec(hook.command ?? "")?.[0];
          // The default command-hook timeout is 600 s, so the bound has to be explicit.
          if (!script || !existsSync(join(ROOT, script)) || !(hook.timeout <= 120)) bad.push(`${event}: ${hook.command ?? hook.type}`);
        }
    expect(bad).toEqual([]);
  });
});

// allowed-tools pre-approves the listed tools until the next user message, skipping workspace
// trust; it never restricts. So neither a command nor the shared settings may pre-approve
// Workflow (a fan-out keeps its human approval) or a grant broad enough to cover the bench
// commands that patch the working tree or write records. Bash(pnpm trace:*) and
// Bash(pnpm -s trace:*) both cover them.
describe("pre-approvals", () => {
  const BENCH_WRITERS = [
    "pnpm trace bench-judge",
    "pnpm -s trace bench-judge",
    "pnpm trace bench-pack",
    "pnpm trace bench-score --record",
    "pnpm -s trace bench-score --record",
  ];
  // Split on commas and whitespace outside parentheses; also accept the YAML-list form.
  const splitRules = (value) => {
    const rules = [];
    let cur = "";
    let depth = 0;
    for (const ch of value) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && (ch === "," || /\s/.test(ch))) {
        if (cur) rules.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) rules.push(cur);
    return rules.map((r) => r.replace(/^["']|["']$/g, ""));
  };
  const allowedTools = (text) => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const m = /^allowed-tools:[ \t]*(.*)$/m.exec(front);
    if (!m) return null;
    if (m[1].trim()) return splitRules(m[1]);
    const list = front.slice(m.index + m[0].length).match(/^(?:\r?\n[ \t]*-[ \t]*.+)+/)?.[0] ?? "";
    return list.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^[ \t]*-[ \t]*/, "").replace(/^["']|["']$/g, ""));
  };
  const dir = join(ROOT, ".claude/commands");
  const commands = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({ file: f, rules: allowedTools(readFileSync(join(dir, f), "utf8")) }))
        .filter((c) => c.rules !== null)
    : [];

  it("every declared allowed-tools list parses to at least one rule", () => {
    expect(commands.filter((c) => c.rules.length === 0).map((c) => c.file)).toEqual([]);
  });

  it("nothing pre-approves Workflow or a grant that covers a bench writer", () => {
    const surfaces = existsSync(SETTINGS) ? [...commands, { file: ".claude/settings.json", rules: settings().permissions?.allow ?? [] }] : commands;
    const offending = surfaces.flatMap((s) =>
      s.rules.filter((r) => /^Workflow\b/.test(r) || BENCH_WRITERS.some((cmd) => coversBash(r, cmd))).map((r) => `${s.file}: ${r}`),
    );
    expect(offending).toEqual([]);
  });
});
