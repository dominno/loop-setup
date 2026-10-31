// Story-map consistency lint (scripts/trace/story-map.mjs): one synthetic story map per rule (each
// one consistent but for the rule under test), the TRACE citation rule against a real temp store
// written through writeRecords / appendActions, and `pnpm trace story-lint` run as a process on a
// temp checkout (real files, real spec-file checks) and on this repo's own docs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendActions, DEFAULT_STORE, loadEntries, loadSchema, readPolicyVersion, replay, ROOT, writeRecords } from "./lib.mjs";
import { STORY_MAP_PATHS, STORY_STATUSES, parseStory, storyClaim, storyMapViolations } from "./story-map.mjs";

const SPECS = new Set(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
const specExists = (p) => SPECS.has(p);
const storyPath = (id) => `${STORY_MAP_PATHS.stories}/${id}-story.md`;

const INDEX = "| ID | Title | Source | Status | File |\n|---|---|---|---|---|";
const DASHBOARD = "| Story | Source doc | Implementation | Unit tests | E2E tests | Browser verified | Final status | Evidence | Next action |\n|---|---|---|---|---|---|---|---|---|";
const LOG = "| Date | Story ID | Check performed | Command / action | Result | Notes |\n|---|---|---|---|---|---|";
const COVERAGE = "| Story ID | User flow | E2E test file | Happy path | Failure path | Edge cases | Last verified | Gap |\n|---|---|---|---|---|---|---|---|";

// A story file in the template's shape; `record` is the Record: line's value (null: no Record: line).
const storyText = ({ id, status, record = "(pre-TRACE)", acs = ["- [x] AC1: it works"], extra = "" }) =>
  [`# ${id}: A story`, "", "**Acceptance criteria:**", ...acs, "", "**Final status:**", status, ...(record === null ? [] : [`Record: ${record}`]), "", "**Next action:**", "None.", extra, ""].join("\n");

/**
 * A synthetic story map, consistent by default: each story is E2E tested (Record: (pre-TRACE)), with
 * a verification-log row and a coverage row citing e2e/a.spec.ts. Per story: `index` / `dashboard`
 * set that row's status (null drops the row), `file: false` drops the story file, `log: false` its
 * log row, and `spec` the spec its coverage row cites (null drops the row). `over` replaces files.
 */
function storyMap(stories, over = {}) {
  const all = stories.map((s) => ({ status: "E2E tested", spec: "e2e/a.spec.ts", log: true, ...s }));
  const rows = (keep, row) => all.filter(keep).map(row).join("\n");
  return {
    stories: all.filter((s) => s.file !== false).map((s) => ({ path: storyPath(s.id), text: storyText(s) })),
    index: {
      path: STORY_MAP_PATHS.index,
      text: `# User Stories — index\n\n## Stories\n${INDEX}\n${rows((s) => s.index !== null, (s) => `| ${s.id} | A story | \`docs/prd.md\` | ${s.index ?? s.status} | [stories/${s.id}-story.md](./stories/${s.id}-story.md) |`)}\n`,
    },
    dashboard: {
      path: STORY_MAP_PATHS.dashboard,
      text: `# Implementation Status\n\n${DASHBOARD}\n${rows((s) => s.dashboard !== null, (s) => `| [${s.id}](./stories/${s.id}-story.md) | \`docs/prd.md\` | Present | Present | Present | Automated only | ${s.dashboard ?? s.status} | a run | none |`)}\n\n## Status model\n\n| Status | Meaning |\n|---|---|\n| \`Done\` | Done |\n`,
    },
    log: { path: STORY_MAP_PATHS.log, text: `# Story Verification Log\n\n${LOG}\n${rows((s) => s.log, (s) => `| 2026-10-01 | ${s.id} | Unit tests | \`pnpm test\` | Pass | 1/1 |`)}\n` },
    coverage: { path: STORY_MAP_PATHS.coverage, text: `# E2E Coverage Map\n\n${COVERAGE}\n${rows((s) => s.spec !== null, (s) => `| ${s.id} | A flow | \`${s.spec}\` | Yes | Yes | — | 2026-10-01 | None |`)}\n` },
    ...over,
  };
}
const lint = (stories, over, state) => storyMapViolations(storyMap(stories, over), state, { specExists });
// Every message starts with its rule tag (e2e-coverage has a digit), then the story id when it is about one story.
const rulesOf = (msgs) => msgs.map((m) => /^\[([a-z0-9-]+)\]/.exec(m)?.[1]);
const flagged = (msgs, rule) => [...new Set(msgs.filter((m) => m.startsWith(`[${rule}] `)).map((m) => /^\[[a-z0-9-]+\] (US-\d+)/.exec(m)?.[1]))];

describe("parseStory", () => {
  it("reads the status under **Final status:** (on its line or the next), the Record: line only in that section, and unchecked ACs only in the AC section", () => {
    const text = [
      "# US-007: X", // 1
      "",
      "**Acceptance criteria:**",
      "- [ ] AC1: open", // 4
      "- [x] AC2: done",
      "",
      "**Implementation evidence:**",
      "- Status: Implemented",
      "- [ ] not an acceptance criterion",
      "Record: TR-111111111111", // 10: not under Final status
      "",
      "**Final status:** `Unit tested`", // 12
      "**Record:** `TR-0123456789ab` (the record behind this status)", // 13
      "",
      "**Next action:**",
      "Record: TR-222222222222",
      "",
    ].join("\n");
    expect(parseStory({ path: storyPath("US-007"), text })).toMatchObject({
      id: "US-007",
      status: { value: "Unit tested", line: 12 },
      record: { line: 13, ids: ["TR-0123456789ab"], preTrace: false },
      unchecked: [{ line: 4, text: "- [ ] AC1: open" }],
    });
  });

  it("reads 'Record: (pre-TRACE)' as the grandfather marker and the template's placeholder as no record; the status is the section's first other line", () => {
    const at = (body) => parseStory({ path: storyPath("US-001"), text: `# US-001: X\n\n**Final status:**\n${body}\n` });
    expect(at("\nE2E tested\nRecord: (pre-TRACE)")).toMatchObject({ status: { value: "E2E tested", line: 5 }, record: { ids: [], preTrace: true } });
    expect(at("Record: (pre-TRACE)\nImplemented")).toMatchObject({ status: { value: "Implemented" }, record: { preTrace: true } });
    expect(at("Implemented\nRecord: `TR-xxxxxxxxxxxx` (the TRACE-lite record behind this status)")).toMatchObject({ record: { ids: [], preTrace: false } });
    expect(parseStory({ path: storyPath("US-001"), text: "# US-001: X\n\nno status here\n" })).toMatchObject({ status: null, finalLine: null, record: null });
    expect(parseStory({ path: `${STORY_MAP_PATHS.stories}/US-abc.md`, text: "" }).id).toBeNull();
  });
});

describe("story-lint: the story map against itself", () => {
  it("a consistent story map has no errors and no warnings", () => {
    expect(lint([{ id: "US-001" }, { id: "US-002", status: "Implemented", spec: null, log: false }])).toEqual({ errors: [], warnings: [], stories: 2, absent: false });
  });

  it("an absent story map passes vacuously", () => {
    const none = { path: STORY_MAP_PATHS.index, text: null };
    expect(storyMapViolations({ stories: [], index: none, dashboard: { ...none, path: STORY_MAP_PATHS.dashboard } })).toEqual({ errors: [], warnings: [], stories: 0, absent: true });
    expect(storyMapViolations({})).toEqual({ errors: [], warnings: [], stories: 0, absent: true });
  });

  it("(1) the story files, the index and the dashboard list one set of ids; every miss names a file and line", () => {
    const { errors } = lint([{ id: "US-001" }, { id: "US-002", index: null }, { id: "US-003", dashboard: null }, { id: "US-004", file: false }]);
    expect(flagged(errors, "id-set")).toEqual(["US-002", "US-003", "US-004"]);
    expect(rulesOf(errors).every((r) => r === "id-set")).toBe(true);
    expect(errors.find((e) => e.includes("US-002"))).toContain(`${storyPath("US-002")}:1`);
    expect(errors.find((e) => e.includes("US-002"))).toContain(STORY_MAP_PATHS.index);
    expect(errors.find((e) => e.includes("US-003"))).toContain(STORY_MAP_PATHS.dashboard);
    expect(errors.find((e) => e.includes("US-004"))).toMatch(new RegExp(`${STORY_MAP_PATHS.index}:\\d+`));
  });

  it("(1) a story listed twice (two story files, or two rows in one table) and a misnamed story file are errors", () => {
    const map = storyMap([{ id: "US-001" }]);
    map.stories.push({ path: `${STORY_MAP_PATHS.stories}/US-001-again.md`, text: storyText({ id: "US-001", status: "E2E tested" }) });
    map.stories.push({ path: `${STORY_MAP_PATHS.stories}/US-abc.md`, text: storyText({ id: "US-abc", status: "E2E tested" }) });
    map.index.text += "| US-001 | Again | x | E2E tested | f |\n";
    const { errors } = storyMapViolations(map, undefined, { specExists });
    expect(rulesOf(errors).sort()).toEqual(["duplicate", "duplicate", "id"]);
    expect(flagged(errors, "duplicate")).toEqual(["US-001"]);
  });

  it("(2) a story's Final status equals its index and dashboard status — a mismatch names both files and lines", () => {
    const { errors } = lint([{ id: "US-001", index: "Implemented" }, { id: "US-002", dashboard: "Unit tested" }]);
    expect(rulesOf(errors)).toEqual(["status", "status"]);
    expect(flagged(errors, "status")).toEqual(["US-001", "US-002"]);
    // Index line 6 is US-001's row, dashboard line 6 is US-002's, and line 7 of a story file is its status line.
    expect(errors[0]).toContain(`${STORY_MAP_PATHS.index}:6`);
    expect(errors[0]).toContain(`${storyPath("US-001")}:7`);
    expect(errors[1]).toContain(`${STORY_MAP_PATHS.dashboard}:6`);
    expect(errors[1]).toContain(`${storyPath("US-002")}:7`);
  });

  it("(2) a status that is not one of the 9 is an error, and so is a story file without a Final status", () => {
    const { errors } = lint([{ id: "US-001", status: "In progress" }, { id: "US-002", index: "e2e tested" }]);
    expect(rulesOf(errors)).toEqual(["status", "status"]);
    expect(flagged(errors, "status")).toEqual(["US-001", "US-002"]);
    const map = storyMap([{ id: "US-003" }, { id: "US-004" }]);
    map.stories[0].text = "# US-003: A story\n\n**Acceptance criteria:**\n- [x] AC1\n";
    map.stories[1].text = "# US-004: A story\n\n**Final status:**\n\n**Next action:**\nRecord: (pre-TRACE)\n";
    expect(flagged(storyMapViolations(map, undefined, { specExists }).errors, "status")).toEqual(["US-003", "US-004"]);
  });

  it("an index raised to Done over a pre-TRACE story names both the mismatch and the missing TR record", () => {
    const { errors } = lint([{ id: "US-002", index: "Done" }]);
    expect(rulesOf(errors).sort()).toEqual(["record", "status"]);
    expect(errors.find((e) => e.startsWith("[record] "))).toMatch(/Done.*TR.*pre-TRACE.*Browser verified/);
  });

  it("(3) Unit tested or higher needs a verification-log row; Blocked and Deprecated do not", () => {
    const { errors } = lint(STORY_STATUSES.map((status, i) => ({ id: `US-00${i + 1}`, status, log: false })));
    expect(flagged(errors, "verification-log")).toEqual(["US-004", "US-005", "US-006", "US-007"]); // Unit tested … Done
    // One log row may name several stories.
    const shared = { log: { path: STORY_MAP_PATHS.log, text: `${LOG}\n| 2026-10-01 | US-001, US-002 | Unit tests | \`pnpm test\` | Pass | 2/2 |\n` } };
    expect(lint([{ id: "US-001", log: false }, { id: "US-002", log: false }], shared).errors).toEqual([]);
    // A missing log file is a missing row for every story that needs one.
    const missing = lint([{ id: "US-001" }], { log: { path: STORY_MAP_PATHS.log, text: null } }).errors;
    expect(rulesOf(missing)).toEqual(["verification-log"]);
    expect(missing[0]).toMatch(/missing/);
  });

  it("(4) E2E tested or higher needs an e2e-coverage-map row whose cited spec file exists", () => {
    const map = storyMap([
      { id: "US-001" }, // cites e2e/a.spec.ts, which exists
      { id: "US-002", spec: null }, // no row
      { id: "US-003", spec: "e2e/missing.spec.ts" }, // its only spec does not exist
      { id: "US-004", status: "Unit tested", spec: null }, // below E2E tested: no row needed
      { id: "US-005", spec: "e2e/b.spec.ts" }, // a second row cites a missing spec: one existing spec is enough
      { id: "US-006", spec: "e2e/a.spec.ts:12" }, // a file:line citation names the file
    ]);
    map.coverage.text += "| US-005 | Another flow | `e2e/gone.spec.ts` | Yes | — | — | 2026-10-01 | None |\n";
    const { errors } = storyMapViolations(map, undefined, { specExists });
    expect(rulesOf(errors).every((r) => r === "e2e-coverage")).toBe(true);
    expect(flagged(errors, "e2e-coverage")).toEqual(["US-002", "US-003"]);
    expect(errors.find((e) => e.includes("US-003"))).toContain("e2e/missing.spec.ts");
  });

  it("(5) an unchecked AC at Implemented or higher is a warning, never an error", () => {
    const res = lint([
      { id: "US-001", status: "Implemented", acs: ["- [x] AC1: done", "- [ ] AC2: not yet"] },
      { id: "US-002", status: "Partially implemented", acs: ["- [ ] AC1: not yet"] },
      { id: "US-003", acs: ["- [x] AC1: done"], extra: "**Notes:**\n- [ ] browser-verify it" }, // a checkbox outside the AC section is no AC
    ]);
    expect(res.errors).toEqual([]);
    expect(rulesOf(res.warnings)).toEqual(["unchecked-ac"]);
    expect(flagged(res.warnings, "unchecked-ac")).toEqual(["US-001"]);
  });

  it("(6) any status but Not started needs a Record: line — a TR id, or (pre-TRACE) only below Browser verified", () => {
    const { errors } = lint([
      { id: "US-001", status: "Not started", record: null }, // nothing to license yet
      { id: "US-002", status: "Implemented", record: null }, // no Record: line
      { id: "US-003", status: "Implemented", record: "`TR-xxxxxxxxxxxx` (the template's placeholder)" }, // no TR id
      { id: "US-004" }, // E2E tested, pre-TRACE: allowed
      { id: "US-005", status: "Browser verified" }, // pre-TRACE at Browser verified
      { id: "US-006", status: "Done" }, // pre-TRACE at Done
      { id: "US-007", status: "Blocked" }, // pre-TRACE: allowed (off the evidence ladder, so not Browser verified or above)
      { id: "US-008", status: "Deprecated", record: null }, // no Record: line
    ]);
    expect(rulesOf(errors).every((r) => r === "record")).toBe(true);
    expect(flagged(errors, "record")).toEqual(["US-002", "US-003", "US-005", "US-006", "US-008"]);
    // Blocked and Deprecated rank above Not started: an index saying Not started never hides the story file's Blocked.
    const masked = lint([{ id: "US-001", status: "Blocked", record: null, index: "Not started" }]).errors;
    expect(rulesOf(masked).sort()).toEqual(["record", "status"]);
  });

  it("a story-map file that is missing or has lost its table fails closed, naming the file", () => {
    const missing = lint([{ id: "US-001" }], { dashboard: { path: STORY_MAP_PATHS.dashboard, text: null } }).errors;
    expect(rulesOf(missing)).toEqual(["file"]);
    expect(missing[0]).toContain(STORY_MAP_PATHS.dashboard);
    const noTable = lint([{ id: "US-001" }], { index: { path: STORY_MAP_PATHS.index, text: "# User Stories\n\nno table here\n" } }).errors;
    expect(rulesOf(noTable)).toEqual(["table"]);
    expect(noTable[0]).toContain(STORY_MAP_PATHS.index);
    // An unreadable log table is one [table] error, not a missing row per story.
    const noLogTable = lint([{ id: "US-001" }, { id: "US-002" }], { log: { path: STORY_MAP_PATHS.log, text: "# Story Verification Log\n\n| Date | Check |\n|---|---|\n" } }).errors;
    expect(rulesOf(noLogTable)).toEqual(["table"]);
  });
});

describe("story-lint: a cited TR id (a temp store written by writeRecords / appendActions)", () => {
  const schema = loadSchema();
  const POLICY = readPolicyVersion();
  let dir;
  let store;
  let tick;
  const ctx = () => ({ storePath: store, now: new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString(), policyVersion: POLICY, commit: "abc1234def56", schema });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-story-"));
    store = join(dir, "records.jsonl");
    tick = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The scan-docs status verifier's record for a story: writer and claim_id as scan-docs.js writes them.
  const storyRec = (id, over = {}) => ({
    writer_id: `scan-docs/verify:${id}-0`,
    claim_id: storyClaim(id),
    claim_text: `Story ${id} (A story) is at status "E2E tested"`,
    claim_type: "factual",
    subject: id,
    evidence: [{ kind: "command", ref: "pnpm test:e2e", result: "1 passed" }],
    final_status: "accept",
    reason: "the E2E spec covers the flow",
    provenance: { workflow: "scan-docs" },
    ...over,
  });
  const write = (draft) => {
    const [res] = writeRecords([draft], ctx());
    expect(res.validation).toBe("pass");
    return res.record_id;
  };
  const act = (record_id, action, ref) => {
    const [res] = appendActions([{ record_id, consumer: "story-status", action, ...(ref ? { ref } : {}) }], ctx());
    expect(res.validation).toBe("pass");
  };
  const lintStored = (stories) => storyMapViolations(storyMap(stories), replay(loadEntries(store), schema, POLICY), { specExists });

  it("the claim is story:<id>:status, lowercased exactly as scan-docs writes it", () => {
    expect(storyClaim("US-001")).toBe("story:us-001:status");
  });

  it("(7) a cited record must resolve, be the story's own status claim, license (accept/qualify) and carry COMMIT or COMMIT_QUALIFIED", () => {
    const ok = write(storyRec("US-001"));
    act(ok, "COMMIT", "US-001");
    const qualified = write(storyRec("US-002", { final_status: "qualify", qualifier: "holds at Unit tested" }));
    act(qualified, "COMMIT_QUALIFIED", "US-002");
    const otherClaim = write(storyRec("US-003", { claim_id: storyClaim("US-099") }));
    act(otherClaim, "COMMIT", "US-003");
    const deferred = write(storyRec("US-004", { final_status: "defer", missing: ["an E2E run"], evidence: [] }));
    act(deferred, "HOLD", "US-004");
    const uncommitted = write(storyRec("US-005"));
    const { errors, warnings } = lintStored([
      { id: "US-001", record: `\`${ok}\` (the record behind this status)` },
      { id: "US-002", status: "Unit tested", spec: null, record: qualified },
      { id: "US-003", record: otherClaim },
      { id: "US-004", record: deferred },
      { id: "US-005", record: uncommitted },
      { id: "US-006", record: "TR-000000000000" },
    ]);
    expect(flagged(errors, "status-record")).toEqual(["US-003", "US-004", "US-005"]);
    expect(flagged(errors, "record-unknown")).toEqual(["US-006"]);
    expect(rulesOf(errors).every((r) => r === "status-record" || r === "record-unknown")).toBe(true);
    expect(errors.find((e) => e.includes("US-003"))).toContain(storyClaim("US-003"));
    expect(warnings).toEqual([]);
  });

  it("a record that is not the newest for its claim depends on line order, so it only warns", () => {
    const first = write(storyRec("US-001"));
    act(first, "COMMIT", "US-001");
    write(storyRec("US-001", { final_status: "defer", missing: ["a re-run after the merge"], evidence: [], reason: "re-scanned" })); // newer, same claim
    const res = lintStored([{ id: "US-001", record: first }]);
    expect(res.errors).toEqual([]);
    expect(rulesOf(res.warnings)).toEqual(["latest"]);
  });

  it("a store that does not replay vouches for no cited record ([store]); a map that cites none never consults it", () => {
    const ok = write(storyRec("US-001"));
    act(ok, "COMMIT", "US-001");
    appendFileSync(store, "not json\n");
    const res = lintStored([{ id: "US-001", record: ok }]);
    expect(rulesOf(res.errors)).toEqual(["store"]);
    expect(res.errors[0]).toContain(`${storyPath("US-001")}:8`);
    expect(lintStored([{ id: "US-001" }]).errors).toEqual([]);
  });
});

describe("pnpm trace story-lint (CLI process)", () => {
  const CLI = join(ROOT, "scripts/trace/cli.mjs");
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-story-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const trace = (args, store = join(dir, "records.jsonl")) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TRACE_STORE: store } });
  // A temp checkout holding a synthetic story map and the spec files it cites.
  const checkout = (map) => {
    const root = join(dir, "checkout");
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    for (const f of [...map.stories, map.index, map.dashboard, map.log, map.coverage]) put(f.path, f.text);
    for (const spec of SPECS) put(spec, "// a spec\n");
    return root;
  };

  it("reads this repo's own story map by default, and it passes against the committed store (the real docs)", () => {
    const res = trace(["story-lint"], DEFAULT_STORE);
    expect(res.stderr).not.toMatch(/^error:/m);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, errors: 0 });
  });

  it("on a temp checkout: exit 0 when consistent; exit 1 naming both the mismatch and the missing TR record once US-002's index status is raised to Done", () => {
    const root = checkout(storyMap([{ id: "US-001" }, { id: "US-002" }]));
    const ok = trace(["story-lint", "--root", root]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, errors: 0, warnings: 0, stories: 2 });
    const index = join(root, STORY_MAP_PATHS.index);
    writeFileSync(index, readFileSync(index, "utf8").replace(/^(\| US-002 \|.*\|) E2E tested (\|.*)$/m, "$1 Done $2"));
    const bad = trace(["story-lint", "--root", root]);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, errors: 2 });
    expect(bad.stderr).toMatch(new RegExp(`^error: \\[status\\] US-002 \\(${STORY_MAP_PATHS.index}:7\\)`, "m"));
    expect(bad.stderr).toMatch(/^error: \[record\] US-002 .*Done.*TR/m);
  });

  it("checks cited spec files on disk: deleting the one spec a story cites fails rule (4)", () => {
    const root = checkout(storyMap([{ id: "US-001" }, { id: "US-002", spec: "e2e/b.spec.ts" }]));
    rmSync(join(root, "e2e/a.spec.ts"));
    const res = trace(["story-lint", "--root", root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^error: \[e2e-coverage\] US-001 .*e2e\/a\.spec\.ts/m);
    expect(res.stderr).not.toMatch(/US-002/);
  });

  it("a cited spec counts only inside the checkout: a file beside it, cited with ../ or by its absolute path, fails rule (4)", () => {
    const outside = join(dir, "outside.spec.ts"); // next to the checkout, not in it
    writeFileSync(outside, "// a spec outside the checkout\n");
    const root = checkout(storyMap([{ id: "US-001" }, { id: "US-002", spec: "../outside.spec.ts" }, { id: "US-003", spec: outside }]));
    const res = trace(["story-lint", "--root", root]);
    const errors = res.stderr.split("\n").filter((l) => l.startsWith("error: ")).map((l) => l.slice("error: ".length));
    expect(flagged(errors, "e2e-coverage")).toEqual(["US-002", "US-003"]);
    expect(rulesOf(errors)).toEqual(["e2e-coverage", "e2e-coverage"]);
    expect(errors[0]).toMatch(/^\[e2e-coverage\] US-002 .*\.\.\/outside\.spec\.ts \(line \d+\) is not a file in the repo$/);
    expect(res.status).toBe(1);
  });

  it("an absent story map passes vacuously (exit 0); --root without a value is a usage error (exit 2)", () => {
    const res = trace(["story-lint", "--root", dir]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, errors: 0, stories: 0, absent: true });
    expect(trace(["story-lint", "--root"]).status).toBe(2);
  });
});
