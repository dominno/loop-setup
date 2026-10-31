// Template-only doc gates: checks on this template's own instruction and guide prose, and on
// the ignore rules it ships. It sits outside scripts/trace/ on purpose, so an adopter who
// copies scripts/trace/ does not inherit assertions about wording and choices they will
// rewrite (the portable settings gates live in scripts/trace/config.test.mjs).
// Prose is compared with whitespace collapsed: re-wrapping a paragraph never trips a check,
// and a phrase split across a line break still counts as present.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const prose = (rel) => read(rel).replace(/\s+/g, " ");
// The body of a markdown section: from its heading line to the next "## " heading.
const section = (text, heading) => {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const body = text.slice(start + heading.length + 2);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
};
const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
const inGitCheckout = git("rev-parse", "--is-inside-work-tree").stdout?.trim() === "true";

describe("CLAUDE.md governing rules", () => {
  const claudeMd = prose("CLAUDE.md");

  it("states every governing rule", () => {
    // One distinctive phrase per rule: rewording a rule is fine, dropping one is not.
    const anchors = [
      "Commit by pathspec", // commits name their paths; other agents share the checkout
      "git rm --cached", // the index-commit exception for a file untracked but still on disk
      "fix forward", // pushed history is never rewritten; TRACE records cite commit SHAs
      "Fix attempts are bounded", // repeated failures stop, re-diagnose, then report a blocker
      "Do not weaken or delete an assertion", // a changed expectation states its root cause
      "Mocks don't prove integration", // mock-only coverage is reported as unit-tested only
      "Lead session only", // workflow subagents never start, stop or kill servers
      "observed in full", // test results come from complete output seen this session
      "stopping on a bound is not completing", // loop step 16: a fix-attempt bound is not a finish
      "never accepted as clean", // completion gate: a round with a failed lens is re-run
    ];
    expect(anchors.filter((a) => !claudeMd.includes(a))).toEqual([]);
  });

  it("no longer ties the commit allow rule to settings.local.json", () => {
    // An allow rule can be configured in any settings file, so the rule names none.
    const retired = ["pre-allowed in `settings.local.json`"];
    expect(retired.filter((p) => claudeMd.includes(p))).toEqual([]);
  });
});

describe("loop.md consumer procedure", () => {
  it("a check that fails after an apply leaves the node on a revise of its own claim", () => {
    // plan-items passes a ready node's own loop:<id> record on as priorRecordId: left on the superseded
    // accept, the next verdict would fork the claim's revises chain (plan-lint only warns [latest]).
    const loop = prose(".claude/loop.md");
    const anchors = ["write a `revise` record (same `claim_id`", "leave the node `ready` with that record and the attempt counted"];
    expect(anchors.filter((a) => !loop.includes(a))).toEqual([]);
  });
});

describe.skipIf(!inGitCheckout)("agent files stay out of git", () => {
  it("ignores agent worktrees", () => {
    expect(git("check-ignore", "-q", "--", ".claude/worktrees/x/a.ts").status).toBe(0);
  });
});

describe("ESLint", () => {
  it("ignores agent worktrees (flat config does not read .gitignore)", async () => {
    expect(await new ESLint({ cwd: ROOT }).isPathIgnored(".claude/worktrees/x/src/a.ts")).toBe(true);
  }, 30_000);
});

describe("adoption docs", () => {
  it("list every portable path from the adoption guide in the README quickstart and the checklist", () => {
    const guide = read("docs/adoption-guide.md");
    const block = /\*\*Portable[^\n]*\n+```txt\n([\s\S]*?)```/.exec(guide)?.[1] ?? "";
    const paths = new Set();
    for (const line of block.split("\n")) {
      // Columns are separated by 2+ spaces; the last one is the description.
      for (const col of line.split(/\s{2,}/).slice(0, -1)) if (col.trim()) paths.add(col.trim().replace(/\*$/, ""));
      // The scripts/trace/ row also names the package.json script and the unit-test glob.
      for (const m of line.matchAll(/scripts\/[^\s"]+/g)) paths.add(m[0].replace(/\)$/, ""));
    }
    expect(paths.size).toBeGreaterThan(5);
    const quickstart = section(read("README.md"), "## Quickstart: add to an existing project");
    const checklist = /```txt\n([\s\S]*?)```/.exec(section(guide, "## Adoption checklist"))?.[1] ?? "";
    const missing = (text) => [...paths].filter((p) => !text.includes(p));
    expect({ quickstart: missing(quickstart), checklist: missing(checklist) }).toEqual({ quickstart: [], checklist: [] });
  });

  it("name every workflow's budget floors in the guide's budget-floor paragraph, and no floor the code lacks", () => {
    // Each workflow's distinct floor values: `const <NAME>_FLOOR = <N>_000` gives N (thousands of tokens).
    const names = readdirSync(join(ROOT, ".claude/workflows")).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
    const floors = new Map();
    const drift = [];
    for (const name of names) {
      const src = read(`.claude/workflows/${name}.js`);
      // A floor written another way would escape the check, so it fails instead.
      for (const [, constant, value] of src.matchAll(/const (\w+_FLOOR) = ([^\s;]+)/g)) if (!/^\d+_000$/.test(value)) drift.push(`${name}: ${constant} = ${value} is not <N>_000`);
      const values = new Set([...src.matchAll(/const \w+_FLOOR = (\d+)_000\b/g)].map((m) => m[1]));
      if (values.size) floors.set(name, values);
    }
    expect(floors.size).toBeGreaterThan(0);
    // The paragraph (or list item) that names the floors, whitespace collapsed; "" when it is missing,
    // so every floor is reported.
    const paragraph = read("docs/adoption-guide.md").split(/\n\s*\n|\n(?=\s*- )/).map((p) => p.replace(/\s+/g, " ")).find((p) => p.includes("budget floors")) ?? "";
    // Each backticked workflow name opens a segment that runs to the next backticked workflow name.
    const marks = [...paragraph.matchAll(new RegExp(`\`(${names.join("|")})\``, "g"))];
    const segments = new Map();
    marks.forEach((m, i) => segments.set(m[1], (segments.get(m[1]) ?? "") + paragraph.slice(m.index + m[0].length, marks[i + 1]?.index ?? paragraph.length)));
    for (const [name, values] of floors) {
      if (!segments.has(name)) drift.push(`${name}: not named in backticks`);
      else for (const n of values) if (!new RegExp(`(?<![\\d.])${n}k\\b`).test(segments.get(name))) drift.push(`${name}: ${n}k`);
    }
    // And back: every <N>k in a workflow's segment is one of that workflow's floors, so a floor changed
    // in code to a value its segment already names (80k → 60k) still leaves the stale 80k flagged.
    for (const [name, text] of segments) {
      for (const [, n] of text.matchAll(/(?<![\d.])(\d+)k\b/g)) if (!floors.get(name)?.has(n)) drift.push(`${name}: the guide says ${n}k, which is none of its floors`);
    }
    expect(drift).toEqual([]);
  });
});
