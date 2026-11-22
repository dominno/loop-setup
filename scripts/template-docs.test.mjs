// Template-only doc gates: checks on this template's own instruction and guide prose, and on
// the shared settings and ignore rules it ships. It sits outside kit/trace/ on purpose, so
// an adopter who copies kit/trace/ does not inherit assertions about wording and choices
// they will rewrite (the portable settings gates live in kit/trace/config.test.mjs).
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
// The loop workspace (wiki, plan): the tests run against the frozen legacy-v1 corpus (vitest.config.ts).
const WS = process.env.LOOP_SETUP_WORKSPACE || join(ROOT, ".claude/loop-workspace");
const readWs = (rel) => readFileSync(join(WS, rel), "utf8");
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
  const kitRules = prose("kit/rules/KIT.md");

  it("states every governing rule: the project's repo rules in CLAUDE.md, the kit's process rules in KIT.md", () => {
    // One distinctive phrase per rule: rewording a rule is fine, dropping one is not. The repo rules stay
    // in the project's CLAUDE.md so a teammate or cloud session without the kit still gets them.
    const repoRules = [
      "Commit by pathspec", // commits name their paths; other agents share the checkout
      "git rm --cached", // the index-commit exception for a file untracked but still on disk
      "fix forward", // pushed history is never rewritten; TRACE records cite commit SHAs
      "Fix attempts are bounded", // repeated failures stop, re-diagnose, then report a blocker
      "Do not weaken or delete an assertion", // a changed expectation states its root cause
      "Mocks don't prove integration", // mock-only coverage is reported as unit-tested only
      "Lead session only", // workflow subagents never start, stop or kill servers
    ];
    const kitProcess = [
      "observed in full", // test results come from complete output seen this session
      "stopping on a bound is not completing", // loop step 16: a fix-attempt bound is not a finish
      "never accepted as clean", // completion gate: a round with a failed lens is re-run
    ];
    expect(repoRules.filter((a) => !claudeMd.includes(a))).toEqual([]);
    expect(kitProcess.filter((a) => !kitRules.includes(a))).toEqual([]);
  });

  it("the project CLAUDE.md carries no kit machinery and imports nothing from the workspace", () => {
    expect(read("CLAUDE.md")).not.toMatch(/^@/m);
    expect(claudeMd).not.toContain("## Multi-Agent Development Workflow");
    expect(kitRules).toContain("## Multi-Agent Development Workflow");
  });

  it("KIT.md carries the session digest within the SessionStart budget", () => {
    const digest = /<!--\s*digest:start\s*-->([\s\S]*?)<!--\s*digest:end\s*-->/.exec(read("kit/rules/KIT.md"))?.[1] ?? "";
    expect(digest.length).toBeGreaterThan(500);
    expect(digest.length).toBeLessThanOrEqual(5500);
    for (const a of ["/write-goal", "loop-setup sync", "Maker/checker", "Scope control"]) expect(digest, a).toContain(a);
  });

  it("no longer ties the commit allow rule to settings.local.json", () => {
    // An allow rule can be configured in any settings file, so the rule names none.
    const retired = ["pre-allowed in `settings.local.json`"];
    expect(retired.filter((p) => claudeMd.includes(p))).toEqual([]);
  });
});

describe("design principles: hexagonal architecture first, then SOLID, KISS, DRY", () => {
  const claudeMd = prose("CLAUDE.md");
  const principles = section(read("CLAUDE.md"), "## Design principles").replace(/\s+/g, " ");

  it("CLAUDE.md makes hexagonal architecture the default for new and changed code and explains what each principle buys", () => {
    expect(principles.length).toBeGreaterThan(0);
    for (const a of ["Hexagonal architecture (ports and adapters)", "dependency rule", "Driving adapters", "Driven adapters", "SOLID", "KISS", "DRY", "TDD"]) {
      expect(principles, a).toContain(a);
    }
    expect((principles.match(/What it buys:/g) || []).length).toBeGreaterThanOrEqual(4); // hexagonal, SOLID, KISS, DRY
    expect(principles).toContain("src/lib/rememberedName.ts"); // names the adapter that has no port yet
    expect(claudeMd).toContain("see *Design principles*"); // the development rule points at the section
  });

  it("the commands that plan and build code, and the architecture critic, apply it", () => {
    for (const f of ["kit/commands/multi-agent-dev.md", "kit/commands/write-goal.md", "kit/commands/plan-nodes.md"]) {
      expect(prose(f), f).toContain("hexagonal");
    }
    for (const f of ["kit/workflows/critic-panel.js", "kit/workflows/trace-bench.js"]) {
      expect(read(f), f).toMatch(/key: 'frontend-arch'[^\n]*Hexagonal boundaries/);
    }
  });
});

describe("loop.md consumer procedure", () => {
  it("a check that fails after an apply leaves the node on a revise of its own claim", () => {
    // plan-items passes a ready node's own loop:<id> record on as priorRecordId: left on the superseded
    // accept, the next verdict would fork the claim's revises chain (plan-lint only warns [latest]).
    const loop = prose("kit/loop.md");
    const anchors = ["write a `revise` record (same `claim_id`", "leave the node `ready` with that record and the attempt counted"];
    expect(anchors.filter((a) => !loop.includes(a))).toEqual([]);
  });
});

describe("L3 requires the sandbox (kit/loop-checklist.md and kit/rules/KIT.md)", () => {
  // One sentence, carried by both the readiness checklist and the kit rules (parity): without the
  // sandbox the loop's Bash runs as the user and can rewrite the kit, its manifest and the settings.
  const STATEMENT = "sandbox-off L2 has no local tamper resistance";
  const checklist = prose("kit/loop-checklist.md");
  const kitRules = prose("kit/rules/KIT.md");

  it("the checklist and the kit rules both state that sandbox-off L2 has no local tamper resistance", () => {
    expect(checklist.toLowerCase()).toContain(STATEMENT.toLowerCase());
    expect(kitRules.toLowerCase()).toContain(STATEMENT.toLowerCase());
  });

  it("the checklist's L3 items name the sandbox settings l3-check reads, both pinned blocks, and doctor's report", () => {
    const anchors = ["`sandbox.enabled: true`", "`sandbox.allowUnsandboxedCommands: false`", "`sandbox.excludedCommands`", "user scope", "`<loop-verifier>`", "`<loop-denylist>`", "`loop-setup l3-check`", "`loop-setup doctor`"];
    expect(anchors.filter((a) => !checklist.includes(a))).toEqual([]);
  });
});

describe("planning upgrade (docs/plans/planning-upgrade/04-spec.md)", () => {
  it("W0: L2 needs one logged L1 iteration with a re-plan delta and a passing pre-dispatch plan-lint", () => {
    const checklist = prose("kit/loop-checklist.md");
    const anchors = ["**(before L2)**", "at least one L1 iteration logged in `loop-run-log.md` with a re-plan delta", "`loop-setup plan-lint --pre-dispatch` passed on a non-empty plan"];
    expect(anchors.filter((a) => !checklist.includes(a))).toEqual([]);
  });

  it("the not-adopted plan borrowings are written down once, each with what would reopen it, and loop-plan.md points there", () => {
    const page = section(readWs("topics/workflow.md"), "## Not adopted (plan)");
    for (const item of ["JSON plan", "epic/parent", "complexity score", "new node status"]) expect(page, item).toContain(item);
    expect((page.match(/Reopen when/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(page).toContain("plan-items item shape");
    expect(readWs("loop-plan.md").replace(/\s+/g, " ")).toContain("*Not adopted (plan)*");
  });
});

describe("W4.1 /plan-nodes: a confirmation-gated planner, offered by /multi-agent-dev and /write-goal, never invoked by them", () => {
  it("the command appends each proposed node only after the user confirms it, lints the draft first, and is for /loop work only", () => {
    const cmd = prose("kit/commands/plan-nodes.md");
    const anchors = [
      "only after the user confirms it",
      "loop-setup plan-lint --pre-dispatch --plan",
      "for work meant to run through `/loop`",
      "`origin` `plan:<source> <YYYY-MM-DD>`",
      "never sets a node `done`, `deferred` or `escalated`",
    ];
    expect(anchors.filter((a) => !cmd.includes(a))).toEqual([]);
    expect(prose("kit/skills-index.md")).toContain("`/plan-nodes`");
  });

  it("/multi-agent-dev and /write-goal offer /plan-nodes and never run it themselves; /write-goal proposes blocked human:goal rows for an oversize loop goal", () => {
    for (const f of ["kit/commands/multi-agent-dev.md", "kit/commands/write-goal.md"]) {
      expect(prose(f), f).toContain("offer `/plan-nodes`");
      expect(prose(f), f).toContain("never invoke it yourself");
    }
    const goal = prose("kit/commands/write-goal.md");
    for (const a of ["origin `human:goal <YYYY-MM-DD>`", "status `blocked`", "pasting them is the approval"]) expect(goal, a).toContain(a);
  });
});

describe("W4.2 persistent step lists (docs/plans/<slug>/steps.md)", () => {
  const STEP_HEADER = "| id | description | scope | check | after | status | commit |";
  const plans = existsSync(join(ROOT, "docs/plans")) ? readdirSync(join(ROOT, "docs/plans")).filter((d) => existsSync(join(ROOT, "docs/plans", d, "steps.md"))) : [];

  it("/multi-agent-dev writes its plan as a step list in the repo, with follow-ups as child ids", () => {
    const cmd = prose("kit/commands/multi-agent-dev.md");
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
    expect(job).toContain("node kit/trace/cli.mjs reaudit --unreachable --annotate");
    expect(job).toContain("continue-on-error: true");
    const guide = prose("kit/docs/adoption-guide.md");
    expect(guide).toContain("disable squash merging");
  });
});

// Playwright launches exactly the Chromium build its own browsers.json names, so the pin is exact
// (a range would move the build without a deliberate bump), and a Playwright that cannot install
// Chromium on the CI runner is upgraded rather than worked around with a runner pin: the e2e job
// runs on ubuntu-latest like the other jobs (docs/plans/playwright-upgrade/steps.md).
describe("E2E toolchain: an exact Playwright pin, and the e2e job on ubuntu-latest", () => {
  it("@playwright/test is pinned to an exact version, and CI's e2e job runs on ubuntu-latest and installs Chromium with its system deps", () => {
    expect(JSON.parse(read("package.json")).devDependencies["@playwright/test"]).toMatch(/^\d+\.\d+\.\d+$/);
    const ci = read(".github/workflows/verify.yml");
    const start = ci.indexOf("\n  e2e:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    const job = next === -1 ? rest : rest.slice(0, next + 1);
    expect(job).toMatch(/\n {4}runs-on: ubuntu-latest\n/);
    expect(job).toContain("pnpm exec playwright install --with-deps chromium");
  });
});

describe("M7-M10: two developers on one project", () => {
  it("the adoption guide has a 'Working as a team' section covering ids, claims, the lease, union logs, merge commits, shared plans, story sync and /dream, and what stays personal", () => {
    const team = section(read("kit/docs/adoption-guide.md"), "## Working as a team").replace(/\s+/g, " ");
    // The loop state is shared through the claude/loop-state branch (loop-setup sync), not through PRs.
    const anchors = ["loop-setup plan-id", "claim:<owner>@<run-id>", "[claim-conflict]", "commit and push the claim", "merge=union", "disable squash merging", "docs/plans/<slug>/steps.md", "`/sync-story-status` on `main`", "`/dream` edits reach teammates through `loop-setup sync`", "settings.local.json"];
    expect(anchors.filter((a) => !team.includes(a))).toEqual([]);
  });

  it("/sync-story-status runs on main (one status PR at a time) and /dream's wiki edits reach teammates through loop-setup sync, never a hand-edited store", () => {
    const sync = prose("kit/commands/sync-story-status.md");
    for (const a of ["run it on `main`", "re-sync after merging two status PRs"]) expect(sync, a).toContain(a);
    const dream = prose("kit/commands/dream.md");
    for (const a of ["Wiki edits reach teammates through `loop-setup sync`", "a new record that `revises` it"]) expect(dream, a).toContain(a);
  });
});

describe("planning guide (kit/docs/planning-guide.md)", () => {
  it("documents every plan command the trace CLI offers, and README shows the planning infographic (SVG source + PNG)", () => {
    const guide = read("kit/docs/planning-guide.md");
    const help = read("kit/trace/cli.mjs");
    const cmds = ["plan-lint", "plan-ready", "plan-items", "plan-id", "claim-token", "status", "plan-drift", "story-lint", "reaudit"];
    for (const c of cmds) expect(help, c).toContain(`loop-setup ${c}`);
    expect(cmds.filter((c) => !guide.includes(`loop-setup ${c}`))).toEqual([]);
    for (const f of ["docs/infographic-5-planning.svg", "docs/infographic-5-planning.png"]) expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(read("README.md")).toContain("(docs/infographic-5-planning.png)");
    expect(guide).toContain("(infographic-5-planning.png)");
  });
});

describe("README infographics stay true to the repo", () => {
  const svg = (n) => read(`docs/${n}.svg`);
  const NAMES = ["infographic-1-task-cycle", "infographic-2-multi-agent-workflows", "infographic-3-components", "infographic-4-loop-and-adoption", "infographic-5-planning", "infographic-6-trace-records", "infographic-7-session-and-state", "infographic-8-trust-boundaries"];

  it("each README infographic has its SVG source next to the PNG", () => {
    for (const n of NAMES) {
      expect(existsSync(join(ROOT, `docs/${n}.svg`)), n).toBe(true);
      expect(read("README.md"), n).toContain(`(docs/${n}.png)`);
    }
  });

  it("the counts drawn on them match the commands and workflows on disk", () => {
    const commands = readdirSync(join(ROOT, "kit/commands")).filter((f) => f.endsWith(".md")).length;
    const workflows = readdirSync(join(ROOT, "kit/workflows")).filter((f) => f.endsWith(".js")).length;
    expect(svg("infographic-3-components")).toContain(`commands/ — ${commands} commands`);
    expect(svg("infographic-3-components")).toContain(`workflows/ — ${workflows} workflows`);
    expect(svg("infographic-2-multi-agent-workflows")).toContain(`${workflows} MULTI-AGENT WORKFLOWS`);
    for (const f of readdirSync(join(ROOT, "kit/workflows")).filter((x) => x.endsWith(".js"))) {
      expect(svg("infographic-2-multi-agent-workflows"), f).toContain(f.replace(/\.js$/, ""));
    }
  });

  it("they draw the installed-kit model: no `pnpm trace`, nothing to copy", () => {
    for (const n of NAMES) {
      const text = svg(n);
      expect(text, n).not.toMatch(/pnpm trace/);
      expect(text, n).not.toMatch(/\bcop(y|ies|ied)\b/i);
      expect(text, n).not.toMatch(/\.claude\/memory/);
    }
    for (const n of ["infographic-3-components", "infographic-4-loop-and-adoption"]) {
      expect(svg(n), n).toMatch(/claude\/loop-state/);
    }
    for (const cmd of ["loop-setup install", "loop-setup init", "loop-setup sync"]) expect(svg("infographic-4-loop-and-adoption"), cmd).toContain(cmd);
  });

  it("the TRACE infographic draws every claim type, verdict and consumer action the record contract knows", async () => {
    const { ACTION_ALLOWED, EVIDENCE_POLICY, VERDICTS } = await import("../kit/trace/lib.mjs");
    const text = svg("infographic-6-trace-records");
    for (const t of Object.keys(EVIDENCE_POLICY)) expect(text, t).toContain(`>${t}<`);
    for (const v of VERDICTS) expect(text, v).toContain(`>${v}<`);
    for (const a of Object.keys(ACTION_ALLOWED)) expect(text, a).toMatch(new RegExp(`>(?:[A-Z_]+ · )?${a}(?: · [A-Z_]+)?<`));
  });

  it("the story-map files drawn on infographic 3 exist", () => {
    for (const f of ["prd.md", "user-stories.md", "implementation-status.md", "e2e-coverage-map.md", "story-verification-log.md", "gaps-and-risks.md"]) {
      expect(svg("infographic-3-components"), f).toContain(f);
      expect(existsSync(join(ROOT, "docs", f)), f).toBe(true);
    }
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
    const guide = read("kit/docs/adoption-guide.md");
    const block = /\*\*Portable[^\n]*\n+```txt\n([\s\S]*?)```/.exec(guide)?.[1] ?? "";
    const paths = new Set();
    for (const line of block.split("\n")) {
      // Columns are separated by 2+ spaces; the last one is the description.
      for (const col of line.split(/\s{2,}/).slice(0, -1)) if (col.trim()) paths.add(col.trim().replace(/\*$/, ""));
      // The kit/trace/ row also names the package.json script and the unit-test glob.
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
    const names = readdirSync(join(ROOT, "kit/workflows")).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
    const floors = new Map();
    const drift = [];
    for (const name of names) {
      const src = read(`kit/workflows/${name}.js`);
      // A floor written another way would escape the check, so it fails instead.
      for (const [, constant, value] of src.matchAll(/const (\w+_FLOOR) = ([^\s;]+)/g)) if (!/^\d+_000$/.test(value)) drift.push(`${name}: ${constant} = ${value} is not <N>_000`);
      const values = new Set([...src.matchAll(/const \w+_FLOOR = (\d+)_000\b/g)].map((m) => m[1]));
      if (values.size) floors.set(name, values);
    }
    expect(floors.size).toBeGreaterThan(0);
    // The paragraph (or list item) that names the floors, whitespace collapsed; "" when it is missing,
    // so every floor is reported.
    const paragraph = read("kit/docs/adoption-guide.md").split(/\n\s*\n|\n(?=\s*- )/).map((p) => p.replace(/\s+/g, " ")).find((p) => p.includes("budget floors")) ?? "";
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
  // Each list that enumerates the workflows for a reader names every script under kit/workflows/.
  const names = readdirSync(join(ROOT, "kit/workflows")).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)).sort();

  it("the README workflow table, the README file tree and the adoption guide's orchestration list name every workflow", () => {
    const readme = read("README.md");
    // The table's rows after its header, and the file tree's entries under the first `  workflows/` line (.claude's).
    const table = /^\| Workflow \| Backs \|.*\n\|[-| ]+\|\n((?:\|.*\n)+)/m.exec(readme)?.[1] ?? "";
    const tree = /^ {2}workflows\/.*\n((?: {4}.*\n)+)/m.exec(readme)?.[1] ?? "";
    const orchestration = section(read("kit/docs/adoption-guide.md"), "## Multi-agent orchestration (Workflows)").split("\nTo adapt them:")[0];
    const missing = (text, form) => names.filter((n) => !text.includes(form(n)));
    expect(names.length).toBeGreaterThan(0);
    expect({
      table: missing(table, (n) => `| \`${n}.js\` |`),
      tree: missing(tree, (n) => ` ${n}.js `),
      orchestration: missing(orchestration, (n) => `\`${n}\``),
    }).toEqual({ table: [], tree: [], orchestration: [] });
  });
});

describe("the guides document the installed kit", () => {
  it("every loop-setup subcommand in the CLI help appears in the adoption guide or the planning guide", async () => {
    const { USAGE } = await import("../kit/setup/commands.mjs");
    const trace = spawnSync(process.execPath, [join(ROOT, "kit/bin/loop-setup.mjs"), "help"], { encoding: "utf8" }).stdout;
    const subs = [...new Set([...`${USAGE}\n${trace}`.matchAll(/^\s*loop-setup ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]))];
    expect(subs.length).toBeGreaterThan(30);
    const guides = read("kit/docs/adoption-guide.md") + read("kit/docs/planning-guide.md");
    expect(subs.filter((s) => !guides.includes(`loop-setup ${s}`))).toEqual([]);
  });

  it("Path A covers a repo created from the template, both ways, with exact commands, and the README quickstart links it", () => {
    const pathA = section(read("kit/docs/adoption-guide.md"), "## Path A — start a new project from this template");
    // Option 1: remove kit/ (with the kit's vitest include and kit-only CI step) and install from upstream.
    for (const cmd of ["git rm -r -q kit scripts/template-docs.test.mjs", "npm pkg delete scripts.loop-setup", "vitest.config.ts", "provenance", "install --from ~/src/loop-setup"]) expect(pathA, cmd).toContain(cmd);
    // Option 2: keep kit/ as the kit source and install from the repo itself.
    expect(pathA).toContain("node kit/bin/loop-setup.mjs install --from .");
    expect(read("README.md")).toContain("kit/docs/adoption-guide.md#path-a--start-a-new-project-from-this-template");
  });
});
