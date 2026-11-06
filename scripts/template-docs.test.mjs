// Template-only doc gates: checks on this template's own instruction and guide prose, and on
// the shared settings and ignore rules it ships. It sits outside scripts/trace/ on purpose, so
// an adopter who copies scripts/trace/ does not inherit assertions about wording and choices
// they will rewrite (the portable settings gates live in scripts/trace/config.test.mjs).
// Prose is compared with whitespace collapsed: re-wrapping a paragraph never trips a check,
// and a phrase split across a line break still counts as present.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

describe("planning upgrade (docs/plans/planning-upgrade/04-spec.md)", () => {
  it("W0: L2 needs one logged L1 iteration with a re-plan delta and a passing pre-dispatch plan-lint", () => {
    const checklist = prose(".claude/loop-checklist.md");
    const anchors = ["**(before L2)**", "at least one L1 iteration logged in `loop-run-log.md` with a re-plan delta", "`pnpm trace plan-lint --pre-dispatch` passed on a non-empty plan"];
    expect(anchors.filter((a) => !checklist.includes(a))).toEqual([]);
  });

  it("the not-adopted plan borrowings are written down once, each with what would reopen it, and loop-plan.md points there", () => {
    const page = section(read(".claude/memory/topics/workflow.md"), "## Not adopted (plan)");
    for (const item of ["JSON plan", "epic/parent", "complexity score", "new node status"]) expect(page, item).toContain(item);
    expect((page.match(/Reopen when/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(page).toContain("plan-items item shape");
    expect(prose(".claude/memory/loop-plan.md")).toContain("*Not adopted (plan)*");
  });
});

describe("W4.1 /plan-nodes: a confirmation-gated planner, offered by /multi-agent-dev and /write-goal, never invoked by them", () => {
  it("the command appends each proposed node only after the user confirms it, lints the draft first, and is for /loop work only", () => {
    const cmd = prose(".claude/commands/plan-nodes.md");
    const anchors = [
      "only after the user confirms it",
      "pnpm trace plan-lint --pre-dispatch --plan",
      "for work meant to run through `/loop`",
      "`origin` `plan:<source> <YYYY-MM-DD>`",
      "never sets a node `done`, `deferred` or `escalated`",
    ];
    expect(anchors.filter((a) => !cmd.includes(a))).toEqual([]);
    expect(prose(".claude/skills-index.md")).toContain("`/plan-nodes`");
  });

  it("/multi-agent-dev and /write-goal offer /plan-nodes and never run it themselves; /write-goal proposes blocked human:goal rows for an oversize loop goal", () => {
    for (const f of [".claude/commands/multi-agent-dev.md", ".claude/commands/write-goal.md"]) {
      expect(prose(f), f).toContain("offer `/plan-nodes`");
      expect(prose(f), f).toContain("never invoke it yourself");
    }
    const goal = prose(".claude/commands/write-goal.md");
    for (const a of ["origin `human:goal <YYYY-MM-DD>`", "status `blocked`", "pasting them is the approval"]) expect(goal, a).toContain(a);
  });
});

describe("W4.2 persistent step lists (docs/plans/<slug>/steps.md)", () => {
  const STEP_HEADER = "| id | description | scope | check | after | status | commit |";
  const plans = existsSync(join(ROOT, "docs/plans")) ? readdirSync(join(ROOT, "docs/plans")).filter((d) => existsSync(join(ROOT, "docs/plans", d, "steps.md"))) : [];

  it("/multi-agent-dev writes its plan as a step list in the repo, with follow-ups as child ids", () => {
    const cmd = prose(".claude/commands/multi-agent-dev.md");
    for (const a of ["`docs/plans/<slug>/steps.md`", STEP_HEADER, "a child id of the step it came from (`S03.1`)", "never only in a scratchpad"]) expect(cmd, a).toContain(a);
  });

  it("every committed step list has the fixed header, unique ids, and children whose parent step exists", () => {
    expect(plans.length).toBeGreaterThan(0);
    for (const d of plans) {
      const text = read(`docs/plans/${d}/steps.md`);
      expect(text, d).toContain(`${STEP_HEADER}\n|---|---|---|---|---|---|---|`);
      const ids = [...text.matchAll(/^\| (S[0-9]+(?:\.[0-9]+)*) \|/gm)].map((m) => m[1]);
      expect(new Set(ids).size, d).toBe(ids.length);
      const orphans = ids.filter((id) => id.includes(".") && !ids.includes(id.slice(0, id.lastIndexOf("."))));
      expect(orphans, d).toEqual([]);
    }
  });
});

describe("M6: merge commits keep TRACE provenance reachable", () => {
  it("CI runs a warn-only provenance job on full history, and the adoption guide says to disable squash merges", () => {
    const ci = read(".github/workflows/verify.yml");
    const job = ci.slice(ci.indexOf("  provenance:"));
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain("node scripts/trace/cli.mjs reaudit --unreachable --annotate");
    expect(job).toContain("continue-on-error: true");
    const guide = prose("docs/adoption-guide.md");
    expect(guide).toContain("disable squash merging");
  });
});

describe("M7-M10: two developers on one project", () => {
  it("the adoption guide has a 'Working as a team' section covering ids, claims, the lease, union logs, merge commits, shared plans, story sync and /dream, and what stays personal", () => {
    const team = section(read("docs/adoption-guide.md"), "## Working as a team").replace(/\s+/g, " ");
    const anchors = ["pnpm trace plan-id", "claim:<owner>@<run-id>", "[claim-conflict]", "commit and push the claim", "merge=union", "disable squash merging", "docs/plans/<slug>/steps.md", "`/sync-story-status` on `main`", "`/dream` through PRs", "settings.local.json"];
    expect(anchors.filter((a) => !team.includes(a))).toEqual([]);
  });

  it("/sync-story-status runs on main (one status PR at a time) and /dream's wiki edits go through PRs, never a hand-edited store", () => {
    const sync = prose(".claude/commands/sync-story-status.md");
    for (const a of ["run it on `main`", "re-sync after merging two status PRs"]) expect(sync, a).toContain(a);
    const dream = prose(".claude/commands/dream.md");
    for (const a of ["wiki edits go through PRs", "a new record that `revises` it"]) expect(dream, a).toContain(a);
  });
});

describe("shared permissions (.claude/settings.json)", () => {
  const allow = () => JSON.parse(read(".claude/settings.json")).permissions?.allow ?? [];

  it("allows every Main-command script", () => {
    const scripts = [...section(read("CLAUDE.md"), "## Main commands").matchAll(/`pnpm ([^`\s]+)`/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const rules = allow();
    expect(scripts.filter((s) => !rules.includes(`Bash(pnpm ${s}:*)`))).toEqual([]);
  });

  it("shares no git add/commit auto-allow and no open-ended pnpm install", () => {
    // git add/commit is a personal opt-in (settings.local.json); `pnpm install <pkg>` adds a dependency.
    const open = allow().filter((r) => /^Bash\(git (add|commit)\b/.test(r) || ["Bash(pnpm install:*)", "Bash(pnpm install *)"].includes(r));
    expect(open).toEqual([]);
  });
});

describe.skipIf(!inGitCheckout)("personal and agent files stay out of git", () => {
  it("does not track settings.local.json, and ignores it and agent worktrees", () => {
    expect(git("ls-files", "--", ".claude/settings.local.json").stdout).toBe("");
    const visible = [".claude/settings.local.json", ".claude/worktrees/x/a.ts"].filter((p) => git("check-ignore", "-q", "--", p).status !== 0);
    expect(visible).toEqual([]);
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

describe("workflow lists", () => {
  // Each list that enumerates the workflows for a reader names every script under .claude/workflows/.
  const names = readdirSync(join(ROOT, ".claude/workflows")).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)).sort();

  it("the README workflow table, the README file tree and the adoption guide's orchestration list name every workflow", () => {
    const readme = read("README.md");
    // The table's rows after its header, and the file tree's entries under the first `  workflows/` line (.claude's).
    const table = /^\| Workflow \| Backs \|.*\n\|[-| ]+\|\n((?:\|.*\n)+)/m.exec(readme)?.[1] ?? "";
    const tree = /^ {2}workflows\/.*\n((?: {4}.*\n)+)/m.exec(readme)?.[1] ?? "";
    const orchestration = section(read("docs/adoption-guide.md"), "## Multi-agent orchestration (Workflows)").split("\nTo adapt them:")[0];
    const missing = (text, form) => names.filter((n) => !text.includes(form(n)));
    expect(names.length).toBeGreaterThan(0);
    expect({
      table: missing(table, (n) => `| \`${n}.js\` |`),
      tree: missing(tree, (n) => ` ${n}.js `),
      orchestration: missing(orchestration, (n) => `\`${n}\``),
    }).toEqual({ table: [], tree: [], orchestration: [] });
  });
});
