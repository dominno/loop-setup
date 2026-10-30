// Template-only doc gates: checks on this template's own instruction and guide prose.
// It sits outside scripts/trace/ on purpose, so an adopter who copies scripts/trace/ does
// not inherit assertions about wording they will rewrite. Prose is compared with
// whitespace collapsed: re-wrapping a paragraph never trips a check, and a phrase split
// across a line break still counts as present.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prose = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\s+/g, " ");

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
    ];
    expect(anchors.filter((a) => !claudeMd.includes(a))).toEqual([]);
  });

  it("no longer ties the commit allow rule to settings.local.json", () => {
    // An allow rule can be configured in any settings file, so the rule names none.
    const retired = ["pre-allowed in `settings.local.json`"];
    expect(retired.filter((p) => claudeMd.includes(p))).toEqual([]);
  });
});
