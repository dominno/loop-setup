// Plan DAG tooling (scripts/trace/plan.mjs): the plan-table parser, loop-plan.md's ready-node
// rule, the plan-items shape, and one test per plan-lint rule. The TRACE cross-checks run against
// a real temp store written through writeRecords/appendActions (the CLI wiring is in cli.test.mjs).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActions, loadEntries, loadSchema, readPolicyVersion, replay, writeRecords } from "./lib.mjs";
import { DEFAULT_PLAN, NOT_READY, dependents, parsePlan, planItems, planViolations, readyIds } from "./plan.mjs";

const HEADER = "| id | description | after | status | record | missing | origin | notes |\n|---|---|---|---|---|---|---|---|";
const planText = (...rows) => `# Loop Plan\n\n## Plan\n_Some prose before the table._\n\n${HEADER}\n${rows.join("\n")}\n`;
// One table row; every cell can be overridden (an empty cell is written as-is).
const row = (id, cells = {}) => {
  const c = { description: `work for ${id}`, after: "", status: "ready", record: "", missing: "", origin: "human", notes: "", ...cells };
  return `| ${id} | ${c.description} | ${c.after} | ${c.status} | ${c.record} | ${c.missing} | ${c.origin} | ${c.notes} |`;
};
const plan = (...rows) => parsePlan(planText(...rows));
// Every lint message starts with its rule tag, then the node id when it is about one node.
const rulesOf = (msgs) => msgs.map((m) => /^\[([a-z-]+)\]/.exec(m)?.[1]);
const flagged = (msgs, rule) => [...new Set(msgs.filter((m) => m.startsWith(`[${rule}] `)).map((m) => /^\[[a-z-]+\] (LP-\d+)/.exec(m)?.[1]))];

describe("parsePlan", () => {
  it("the committed plan parses, and only rows under its '## Plan' heading are nodes (its schema table and fenced example are not)", () => {
    // The loop writes nodes into this table (loop.md step 9), so how many there are is loop state and
    // is never pinned here; that every node comes from under the heading is the contract.
    const doc = readFileSync(DEFAULT_PLAN, "utf8");
    const p = parsePlan(doc);
    expect(p.errors).toEqual([]);
    const heading = doc.split("\n").findIndex((l) => /^##\s+Plan\s*$/.test(l)) + 1;
    expect(heading).toBeGreaterThan(0);
    for (const n of p.nodes) expect(n.line, n.id).toBeGreaterThan(heading);
  });

  it("reads only the table under '## Plan': other tables, a fenced block and later sections are skipped", () => {
    const text = `# Loop Plan\n\n## Node schema\n| Field | Meaning |\n|---|---|\n| \`id\` | x |\n\n## Plan\n\`\`\`\n${row("LP-009")}\n\`\`\`\n\n${HEADER}\n${row("LP-001")}\n\n## Later\n${row("LP-008")}\n`;
    const p = parsePlan(text);
    expect(p.errors).toEqual([]);
    expect(p.nodes.map((n) => n.id)).toEqual(["LP-001"]);
  });

  it("maps '', '—', '–' and '-' to empty, splits after on commas and unescapes escaped pipes", () => {
    const p = plan("| LP-001 | parse a \\| b | LP-002, LP-003 | blocked | — | – | - |  |", row("LP-002"), row("LP-003"));
    expect(p.errors).toEqual([]);
    expect(p.nodes[0]).toMatchObject({ id: "LP-001", description: "parse a | b", after: ["LP-002", "LP-003"], status: "blocked", record: "", missing: "", origin: "", notes: "" });
  });

  it("requires the exact 8-column header and its separator row (fail closed: no nodes)", () => {
    for (const header of [
      "| id | description | after | status | record | missing | notes |\n|---|---|---|---|---|---|---|",
      "| id | description | status | after | record | missing | origin | notes |\n|---|---|---|---|---|---|---|---|",
      "| id | description | after | status | record | missing | origin | notes |",
    ]) {
      const p = parsePlan(`## Plan\n\n${header}\n${row("LP-001")}\n`);
      expect(p.nodes, header).toEqual([]);
      expect(rulesOf(p.errors), header).toContain("header");
    }
  });

  it("a row without 8 cells is an error and is not read as a node", () => {
    const p = plan(row("LP-001"), "| LP-002 | too few | ready |");
    expect(rulesOf(p.errors)).toEqual(["cells"]);
    expect(p.nodes.map((n) => n.id)).toEqual(["LP-001"]);
  });

  it("an id that is not LP- and 3 or more digits, or a duplicate id, is an error", () => {
    const p = plan(row("LP-001"), row("LP-1"), row("lp-002"), row("LP-001"), row("LP-1000"));
    expect(rulesOf(p.errors).sort()).toEqual(["duplicate-id", "id", "id"]);
  });

  it("fails closed without a '## Plan' table, and on rows split off the table by a blank line", () => {
    expect(rulesOf(parsePlan("# Loop Plan\n\nno plan here\n").errors)).toEqual(["table"]);
    expect(rulesOf(parsePlan("## Plan\n_No nodes yet._\n").errors)).toEqual(["table"]);
    expect(rulesOf(parsePlan(`\`\`\`\n## Plan\n${HEADER}\n\`\`\`\n`).errors)).toEqual(["table"]); // a fenced heading is not the plan
    expect(rulesOf(plan(row("LP-001"), "", row("LP-002")).errors)).toEqual(["table"]);
  });

  it("a second '## Plan' section is a [table] error: the plan has exactly one table", () => {
    const p = parsePlan(`${planText(row("LP-001"))}\n## Plan\n\n${HEADER}\n${row("LP-002")}\n`);
    expect(rulesOf(p.errors)).toEqual(["table"]);
    expect(p.errors[0]).toMatch(/a second '## Plan' section/);
    expect(p.nodes.map((n) => n.id)).toEqual(["LP-001"]);
  });

  it("a line directly after the last row (no blank line between) is a [table] error, never silently skipped; a blank line or a heading ends the table cleanly", () => {
    // GFM renders a non-blank line that follows a row, pipe or not, as one more row of the table.
    for (const line of ["a note without a pipe", "LP-002 also ready", "only an escaped \\| pipe"]) {
      const p = plan(row("LP-001"), line);
      expect(rulesOf(p.errors), line).toEqual(["table"]);
      expect(p.errors[0], line).toMatch(/directly after the plan table/);
      expect(p.nodes.map((n) => n.id), line).toEqual(["LP-001"]);
    }
    for (const after of [["", "a note after a blank line"], ["### Archive"]]) {
      expect(plan(row("LP-001"), ...after).errors, JSON.stringify(after)).toEqual([]);
    }
  });

  it("only a '#' or '##' heading ends the Plan section: a row under a deeper heading fails closed instead of being skipped", () => {
    const p = plan(row("LP-001"), "", "### Archive", row("LP-002"));
    expect(rulesOf(p.errors)).toEqual(["table"]);
    expect(p.nodes.map((n) => n.id)).toEqual(["LP-001"]);
  });

  it("a row's leading pipe is optional inside the table (GFM), and a pipe row split off it by a blank line or a fence fails closed", () => {
    const bare = "LP-002 | no leading pipe | — | ready | | | human | |";
    const p = plan(row("LP-001"), bare);
    expect(p.errors).toEqual([]);
    expect(p.nodes.map((n) => [n.id, n.description, n.status])).toEqual([["LP-001", "work for LP-001", "ready"], ["LP-002", "no leading pipe", "ready"]]);
    expect(rulesOf(plan(row("LP-001"), "LP-002 | too few | ready").errors)).toEqual(["cells"]);
    // GFM ends a table at a blank line or a fence (``` or ~~~); a row after either is never read, and never silently dropped.
    for (const split of [[""], ["```", row("LP-009"), "```"], ["~~~", row("LP-009"), "~~~"]]) {
      for (const after of [bare, row("LP-002")]) {
        const q = plan(row("LP-001"), ...split, after);
        expect(rulesOf(q.errors), `${JSON.stringify(split)} ${after}`).toEqual(["table"]);
        expect(q.nodes.map((n) => n.id)).toEqual(["LP-001"]);
      }
    }
  });
});

describe("readyIds (loop-plan.md's ready-node rule, in table order)", () => {
  it("the 4 illustrative rows pasted into a live table give ready [LP-002]", () => {
    const doc = readFileSync(DEFAULT_PLAN, "utf8");
    const example = /## Example[^\n]*\n```\n([\s\S]*?)\n```/.exec(doc)?.[1].split("\n") ?? [];
    expect(example).toHaveLength(4);
    const p = plan(...example);
    expect(p.errors).toEqual([]);
    expect(readyIds(p.nodes)).toEqual(["LP-002"]);
  });

  it("a blocked node whose deps are done is ready; a ready node with an open dep is not", () => {
    const p = plan(row("LP-001", { status: "done" }), row("LP-002", { after: "LP-001", status: "blocked" }), row("LP-003", { after: "LP-002" }));
    expect(readyIds(p.nodes)).toEqual(["LP-002"]);
  });

  it("a dangling after id is never read as done (plan-lint names it; until then its node waits)", () => {
    expect(readyIds(plan(row("LP-002", { after: "LP-001", status: "blocked" }), row("LP-003", { after: "LP-001" })).nodes)).toEqual([]);
  });

  it("--max keeps table order", () => {
    const p = plan(row("LP-005"), row("LP-001"), row("LP-004", { status: "deferred", missing: "m" }), row("LP-003"), row("LP-002"));
    expect(readyIds(p.nodes)).toEqual(["LP-005", "LP-001", "LP-003", "LP-002"]);
    expect(readyIds(p.nodes, { max: 2 })).toEqual(["LP-005", "LP-001"]);
  });

  it("an unknown status is never ready, and neither is any status the rule excludes", () => {
    const p = plan(row("LP-001", { status: "todo" }), row("LP-002", { status: "Ready" }), row("LP-003", { status: "in progress" }), row("LP-004"));
    expect(readyIds(p.nodes)).toEqual(["LP-004"]);
    for (const status of NOT_READY) expect(readyIds(plan(row("LP-001", { status })).nodes), status).toEqual([]);
  });
});

describe("dependents", () => {
  it("is a cycle-safe reverse closure over after edges", () => {
    const p = plan(
      row("LP-001"),
      row("LP-002", { after: "LP-001, LP-003", status: "blocked" }),
      row("LP-003", { after: "LP-002", status: "blocked" }),
      row("LP-004", { after: "LP-003", status: "blocked" }),
      row("LP-005"),
    );
    expect(dependents(p.nodes, "LP-001").sort()).toEqual(["LP-002", "LP-003", "LP-004"]);
    expect(dependents(p.nodes, "LP-002").sort()).toEqual(["LP-003", "LP-004"]);
    expect(dependents(p.nodes, "LP-005")).toEqual([]);
  });
});

describe("plan-lint: structural rules", () => {
  const lint = (...rows) => planViolations(plan(...rows));

  it("a consistent plan has no errors and no warnings", () => {
    expect(lint(row("LP-001"), row("LP-002", { after: "LP-001", status: "blocked" }))).toEqual({ errors: [], warnings: [] });
  });

  it("a table that does not parse is a lint error (wrong header, a row without 8 cells)", () => {
    expect(rulesOf(planViolations(parsePlan("## Plan\n\n| id | description |\n|---|---|\n")).errors)).toEqual(["header"]);
    expect(rulesOf(lint(row("LP-001"), "| LP-002 | short |").errors)).toEqual(["cells"]);
  });

  it("an unknown status", () => {
    expect(flagged(lint(row("LP-001", { status: "todo" })).errors, "status")).toEqual(["LP-001"]);
  });

  it("an after id absent from the table (dangling)", () => {
    expect(flagged(lint(row("LP-002", { after: "LP-001", status: "blocked" })).errors, "dangling")).toEqual(["LP-002"]);
  });

  it("a cycle (a self-dependency is one)", () => {
    const { errors } = lint(row("LP-001", { after: "LP-002", status: "blocked" }), row("LP-002", { after: "LP-001", status: "blocked" }), row("LP-003", { after: "LP-003", status: "blocked" }));
    const cycles = errors.filter((e) => e.startsWith("[cycle] "));
    expect(cycles).toHaveLength(2);
    expect(cycles.join("\n")).toContain("LP-001 → LP-002 → LP-001");
    expect(cycles.join("\n")).toContain("LP-003 → LP-003");
  });

  it("a hand-set ready with an open dependency", () => {
    expect(flagged(lint(row("LP-001", { status: "blocked" }), row("LP-002", { after: "LP-001" })).errors, "hand-set-ready")).toEqual(["LP-002"]);
  });

  it("deferred or escalated with an empty missing", () => {
    const { errors } = lint(row("LP-001", { status: "deferred" }), row("LP-002", { status: "escalated" }), row("LP-003", { status: "deferred", missing: "a unit test run" }));
    expect(flagged(errors, "missing")).toEqual(["LP-001", "LP-002"]);
  });

  it("stranded: in the chain A (escalated) ← B ← C, B and C are flagged, while a deferred ancestor strands nothing", () => {
    const chain = (status) =>
      lint(row("LP-001", { status, missing: "a human decision on the auth flow" }), row("LP-002", { after: "LP-001", status: "blocked" }), row("LP-003", { after: "LP-002", status: "blocked" }));
    expect(flagged(chain("escalated").errors, "stranded")).toEqual(["LP-002", "LP-003"]);
    expect(flagged(chain("dropped").errors, "stranded")).toEqual(["LP-002", "LP-003"]);
    expect(flagged(chain("deferred").errors, "stranded")).toEqual([]);
  });

  it("stranded flags a dependent in every live status (a deferred or in-progress one waits too), never a resolved one", () => {
    const under = (status) => lint(row("LP-001", { status: "escalated", missing: "a human decision" }), row("LP-002", { after: "LP-001", status, missing: "an E2E run" })).errors;
    for (const status of ["ready", "blocked", "in-progress", "deferred"]) expect(flagged(under(status), "stranded"), status).toEqual(["LP-002"]);
    for (const status of ["done", "dropped", "escalated"]) expect(flagged(under(status), "stranded"), status).toEqual([]);
  });
});

describe("plan-lint: TRACE cross-checks (a temp store written by writeRecords / appendActions)", () => {
  const schema = loadSchema();
  const POLICY = readPolicyVersion();
  let dir;
  let store;
  let tick;
  const ctx = () => ({ storePath: store, now: new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString(), policyVersion: POLICY, commit: "abc1234def56", schema });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-plan-"));
    store = join(dir, "records.jsonl");
    tick = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The loop-iteration verifier's record for a node: writer and claim_id as loop-iteration.js writes them.
  const loopRec = (id, over = {}) => ({
    writer_id: `loop-iteration/verify:${id}-0`,
    claim_id: `loop:${id.toLowerCase()}`,
    claim_text: `Apply the fix for ${id}`,
    claim_type: "practical",
    subject: id,
    evidence: [{ kind: "diff", ref: "src/a.ts" }],
    final_status: "accept",
    reason: "the diff is a correct fix",
    provenance: { workflow: "loop-iteration" },
    ...over,
  });
  const deferRec = (id, missing, over = {}) => loopRec(id, { final_status: "defer", missing: [missing], evidence: [{ kind: "reading", ref: "not judged" }], reason: `deferred: ${missing}`, ...over });
  const criticRec = (over = {}) => ({
    writer_id: "critic-panel/verify:qa-e2e-0",
    claim_id: "critic:qa-e2e:cleared-name-path-untested",
    claim_text: "The cleared-name path has no E2E test",
    claim_type: "factual",
    severity: "important",
    evidence: [{ kind: "file_line", ref: "e2e/remember-me.spec.ts:27" }],
    final_status: "accept",
    reason: "no spec exercises it",
    provenance: { workflow: "critic-panel" },
    ...over,
  });
  const write = (draft) => {
    const [res] = writeRecords([draft], ctx());
    expect(res.validation).toBe("pass");
    return res.record_id;
  };
  const act = (record_id, action, ref, consumer = "loop") => {
    const [res] = appendActions([{ record_id, consumer, action, ...(ref ? { ref } : {}) }], ctx());
    expect(res.validation).toBe("pass");
  };
  const replayed = () => replay(loadEntries(store), schema, POLICY);
  const lint = (rows, opts) => planViolations(plan(...rows), replayed(), opts);

  it("a cited record that does not exist (record, origin or notes) is an error; a truncated example id is no citation", () => {
    const real = write(criticRec());
    const { errors } = lint([
      row("LP-001", { record: "TR-000000000000" }),
      row("LP-002", { origin: "critic:qa-e2e rec:TR-111111111111" }),
      row("LP-003", { notes: "reset: evidence TR-222222222222" }),
      row("LP-004", { record: "see the critic record" }),
      row("LP-005", { origin: `critic:qa-e2e rec:${real}`, notes: "like the example's rec:TR-0f…" }),
    ]);
    expect(flagged(errors, "record-unknown")).toEqual(["LP-001", "LP-002", "LP-003", "LP-004"]);
    expect(rulesOf(errors).every((r) => r === "record-unknown")).toBe(true);
  });

  it("done needs the node's own loop-iteration verifier record: licensing, not superseded, with a CLEAR whose ref is the node", () => {
    const ok = write(loopRec("LP-001"));
    act(ok, "CLEAR", "LP-001");
    const deferred = write(deferRec("LP-002", "a unit test run"));
    act(deferred, "HOLD", "LP-002");
    const noClear = write(loopRec("LP-003"));
    const otherRef = write(loopRec("LP-004"));
    act(otherRef, "CLEAR", "LP-099");
    const byLead = write(loopRec("LP-005", { writer_id: "lead" }));
    act(byLead, "CLEAR", "LP-005");
    const otherClaim = write(loopRec("LP-006", { claim_id: "loop:lp-106" }));
    act(otherClaim, "CLEAR", "LP-006");
    const old = write(loopRec("LP-007"));
    act(old, "CLEAR", "LP-007");
    write(loopRec("LP-007", { final_status: "revise", repair: "also cover the empty name", reason: "re-verified after a regression", revises: old }));
    const { errors } = lint([
      row("LP-001", { status: "done", record: ok }),
      row("LP-002", { status: "done", record: deferred }),
      row("LP-003", { status: "done", record: noClear }),
      row("LP-004", { status: "done", record: otherRef }),
      row("LP-005", { status: "done", record: byLead }),
      row("LP-006", { status: "done", record: otherClaim }),
      row("LP-007", { status: "done", record: old }),
      row("LP-008", { status: "done" }),
    ]);
    expect(flagged(errors, "done-record")).toEqual(["LP-002", "LP-003", "LP-004", "LP-005", "LP-006", "LP-007", "LP-008"]);
    expect(rulesOf(errors).every((r) => r === "done-record")).toBe(true);
  });

  it("'latest for its claim' depends on line order, so it is a warning, never an error", () => {
    const first = write(loopRec("LP-001"));
    act(first, "CLEAR", "LP-001");
    write(deferRec("LP-001", "a re-run after the merge")); // newer for the claim, but no `revises`
    const res = lint([row("LP-001", { status: "done", record: first })]);
    expect(res.errors).toEqual([]);
    expect(rulesOf(res.warnings)).toEqual(["latest"]);
  });

  it("the 'latest' warning also covers a deferred or an escalated node's record", () => {
    const olderDefer = write(deferRec("LP-002", "a unit test run"));
    act(olderDefer, "HOLD", "LP-002");
    write(deferRec("LP-002", "an E2E run")); // newer for the claim, but no `revises`
    const olderReject = write(loopRec("LP-003", { final_status: "reject", reason: "touches the auth flow" }));
    act(olderReject, "HOLD", "LP-003");
    write(loopRec("LP-003", { final_status: "revise", repair: "split the change", reason: "re-verified" })); // newer, no `revises`
    const res = lint([
      row("LP-002", { status: "deferred", record: olderDefer, missing: "a unit test run" }),
      row("LP-003", { status: "escalated", record: olderReject, missing: "a human decision on: touches the auth flow" }),
    ]);
    expect(res.errors).toEqual([]);
    expect(flagged(res.warnings, "latest")).toEqual(["LP-002", "LP-003"]);
  });

  it("the 'latest' warning also covers a ready or blocked node that cites its own superseded loop:<id> record (plan-items would pass it on as priorRecordId)", () => {
    // loop.md step 10: when the check after an apply fails, a revise of the same claim supersedes the applied
    // accept and the node goes back to ready with that revise. Left on the accept, the next verdict would fork the chain.
    const failedCheck = (id) => {
      const applied = write(loopRec(id));
      const revise = write(loopRec(id, { final_status: "revise", repair: "the unit test still fails on an empty name", reason: "the smallest relevant check failed after the apply", revises: applied }));
      act(revise, "HOLD", id);
      return { applied, revise };
    };
    const a = failedCheck("LP-001");
    const b = failedCheck("LP-002");
    const nodes = (rec) => [row("LP-001", { record: rec(a), notes: "attempt 1" }), row("LP-002", { after: "LP-003", status: "blocked", record: rec(b), notes: "attempt 1" }), row("LP-003")];
    const stale = lint(nodes((x) => x.applied));
    expect(stale.errors).toEqual([]);
    expect(rulesOf(stale.warnings)).toEqual(["latest", "latest"]);
    expect(flagged(stale.warnings, "latest")).toEqual(["LP-001", "LP-002"]);
    expect(stale.warnings[0]).toContain(a.revise); // names the record to cite instead
    expect(lint(nodes((x) => x.revise))).toEqual({ errors: [], warnings: [] });
    // Only a node's own record is passed on: one that cites another node's record (a cascade node reset to blocked
    // keeps its ancestor's, which the ancestor's later verdicts supersede) is left alone by this rule.
    const cascadeReset = row("LP-004", { after: "LP-001", status: "blocked", record: a.applied, origin: "cascade from LP-001" });
    expect(lint([...nodes((x) => x.revise), cascadeReset])).toEqual({ errors: [], warnings: [] });
  });

  it("deferred needs a defer record with a HOLD: its own loop:<id> record (an agent-failed defer is one)", () => {
    const held = write(deferRec("LP-001", "a unit test run"));
    act(held, "HOLD", "LP-001");
    const infra = write(deferRec("LP-002", "a diff from the implementer (the implementer agent failed — re-dispatch)", { failed_gates: ["agent-failed"] }));
    act(infra, "HOLD");
    const unheld = write(deferRec("LP-003", "an E2E run"));
    const revised = write(loopRec("LP-004", { final_status: "revise", repair: "narrow the selector" }));
    act(revised, "HOLD", "LP-004");
    const foreign = write({ ...deferRec("LP-005", "a measurement"), writer_id: "lead", claim_id: "lead:lp-005-note" });
    act(foreign, "HOLD", "LP-005");
    const { errors } = lint([
      row("LP-001", { status: "deferred", record: held, missing: "a unit test run" }),
      row("LP-002", { status: "deferred", record: infra, missing: "a re-dispatch" }),
      row("LP-003", { status: "deferred", record: unheld, missing: "an E2E run" }),
      row("LP-004", { status: "deferred", record: revised, missing: "narrow the selector" }),
      row("LP-005", { status: "deferred", record: foreign, missing: "a measurement" }),
      row("LP-006", { status: "deferred", missing: "anything" }),
    ]);
    expect(flagged(errors, "deferred-record")).toEqual(["LP-003", "LP-004", "LP-005", "LP-006"]);
    expect(rulesOf(errors).every((r) => r === "deferred-record")).toBe(true);
  });

  it("a critic-origin deferred node cites the critic's defer record, HOLDed for the node (--ref)", () => {
    const finding = write(criticRec({ final_status: "defer", missing: ["an E2E run of the cleared-name path"], evidence: [] }));
    act(finding, "HOLD", "", "critic-round"); // a review-only round's HOLD names no node
    const node = row("LP-001", { status: "deferred", record: finding, missing: "an E2E run of the cleared-name path", origin: `critic:qa-e2e rec:${finding}` });
    expect(flagged(lint([node]).errors, "deferred-record")).toEqual(["LP-001"]);
    act(finding, "HOLD", "LP-001");
    expect(lint([node])).toEqual({ errors: [], warnings: [] });
    // Only a defer fits a deferred node, whoever wrote it: a critic revise or accept HOLDed for the node is refused.
    const revise = write(criticRec({ claim_id: "critic:ux-flow:copy", final_status: "revise", repair: "restate it for the mobile layout only" }));
    act(revise, "HOLD", "LP-002");
    const accepted = write(criticRec({ claim_id: "critic:security:token" }));
    act(accepted, "HOLD", "LP-003");
    const deferredOn = (id, record) => row(id, { status: "deferred", record, missing: "an E2E run", origin: `critic rec:${record}` });
    const { errors } = lint([deferredOn("LP-002", revise), deferredOn("LP-003", accepted)]);
    expect(flagged(errors, "deferred-record")).toEqual(["LP-002", "LP-003"]);
    expect(rulesOf(errors).every((r) => r === "deferred-record")).toBe(true);
  });

  it("escalated needs a HOLDed record: its own loop:<id> record, or (origin 'cascade from <id>') that escalated ancestor's record", () => {
    const rejected = write(loopRec("LP-001", { final_status: "reject", reason: "touches the auth flow" }));
    act(rejected, "HOLD", "LP-001");
    const other = write(criticRec());
    act(other, "HOLD", "LP-003");
    const unheld = write(loopRec("LP-004", { final_status: "reject", reason: "out of scope" }));
    const byLead = write(loopRec("LP-007", { writer_id: "lead", claim_id: "lead:lp-007-note", final_status: "revise", repair: "split the change" }));
    act(byLead, "HOLD", "LP-007");
    const prunedAncestor = write(loopRec("LP-099", { final_status: "reject", reason: "touches the auth flow" }));
    act(prunedAncestor, "HOLD", "LP-099");
    const { errors } = lint([
      row("LP-001", { status: "escalated", record: rejected, missing: "a human decision on: touches the auth flow" }),
      row("LP-002", { after: "LP-001", status: "escalated", record: rejected, missing: "the human decision LP-001 waits on", origin: "cascade from LP-001" }),
      row("LP-003", { after: "LP-001", status: "escalated", record: other, missing: "the human decision LP-001 waits on", origin: "cascade from LP-001" }),
      row("LP-004", { status: "escalated", record: unheld, missing: "a human decision on: out of scope" }),
      row("LP-005", { status: "escalated", record: rejected, missing: "the human decision LP-004 waits on", origin: "cascade from LP-004" }),
      // Each row below fails on exactly one condition.
      row("LP-006", { status: "escalated", missing: "a human decision on: the auth flow" }), // it cites no record
      row("LP-007", { status: "escalated", record: byLead, missing: "a human decision on: split the change" }), // HOLDed for it, but neither its own, a cascade ancestor's nor a critic-panel record
      row("LP-008", { status: "escalated", record: prunedAncestor, missing: "the human decision LP-099 waits on", origin: "cascade from LP-099" }), // HOLDed, but its cascade ancestor is not in the table
    ]);
    expect(flagged(errors, "escalated-record")).toEqual(["LP-003", "LP-004", "LP-005", "LP-006", "LP-007", "LP-008"]);
    expect(rulesOf(errors).every((r) => r === "escalated-record")).toBe(true);
  });

  it("a cascade-escalated node fails on each cascade condition alone: an escalated ancestor, a dependency on it, a HOLD on its record", () => {
    const held = write(loopRec("LP-001", { final_status: "reject", reason: "touches the auth flow" }));
    act(held, "HOLD", "LP-001");
    const deferred = write(deferRec("LP-004", "an E2E run"));
    act(deferred, "HOLD", "LP-004");
    const unheld = write(loopRec("LP-006", { final_status: "reject", reason: "out of scope" }));
    const cascade = (id, from, record, after = from) => row(id, { after, status: "escalated", record, missing: `the human decision ${from} waits on`, origin: `cascade from ${from}` });
    const { errors } = lint([
      row("LP-001", { status: "escalated", record: held, missing: "a human decision on: touches the auth flow" }),
      cascade("LP-002", "LP-001", held), // consistent
      cascade("LP-003", "LP-001", held, ""), // does not depend on its ancestor
      row("LP-004", { status: "deferred", record: deferred, missing: "an E2E run" }),
      cascade("LP-005", "LP-004", deferred), // a deferred ancestor leaves its dependent blocked, never escalated
      row("LP-006", { status: "escalated", record: unheld, missing: "a human decision on: out of scope" }),
      cascade("LP-007", "LP-006", unheld), // the ancestor's record carries no HOLD
    ]);
    expect(flagged(errors, "escalated-record")).toEqual(["LP-003", "LP-005", "LP-006", "LP-007"]);
    expect(rulesOf(errors).every((r) => r === "escalated-record")).toBe(true);
  });

  it("a cascade reaches a node through an intermediate cascade-escalated node: it cites the root's record, origin 'cascade from <root>'", () => {
    const root = write(loopRec("LP-001", { final_status: "reject", reason: "touches the auth flow" }));
    act(root, "HOLD", "LP-001");
    const cascade = (id, after) => row(id, { after, status: "escalated", record: root, missing: "the human decision LP-001 waits on", origin: "cascade from LP-001" });
    const res = lint([
      row("LP-001", { status: "escalated", record: root, missing: "a human decision on: touches the auth flow" }),
      cascade("LP-002", "LP-001"),
      cascade("LP-003", "LP-002"), // depends on LP-001 only through LP-002
    ]);
    expect(res).toEqual({ errors: [], warnings: [] });
  });

  it("an escalated node's own HOLDed record is checked before its origin: a leftover 'cascade from <a done node>' is no error", () => {
    const fixed = write(loopRec("LP-001"));
    act(fixed, "CLEAR", "LP-001");
    const own = write(loopRec("LP-002", { final_status: "reject", reason: "touches the auth flow" }));
    act(own, "HOLD", "LP-002");
    const res = lint([
      row("LP-001", { status: "done", record: fixed }),
      // Cascade-escalated while LP-001 was escalated; once LP-001 was done, LP-002 was re-dispatched and got its own reject.
      row("LP-002", { after: "LP-001", status: "escalated", record: own, missing: "a human decision on: touches the auth flow", origin: "cascade from LP-001" }),
    ]);
    expect(res).toEqual({ errors: [], warnings: [] });
  });

  it("a critic-origin escalated node cites a critic revise, reject or human-decision defer, HOLDed for the node (--ref)", () => {
    const revise = write(criticRec({ claim_id: "critic:ux-flow:copy", final_status: "revise", repair: "restate it for the mobile layout only" }));
    const reject = write(criticRec({ claim_id: "critic:ux-flow:rejected", final_status: "reject" }));
    const human = write(criticRec({ claim_id: "critic:ux-flow:copy-change", final_status: "defer", missing: ["a human decision to change the greeting copy"], evidence: [] }));
    const evidence = write(criticRec({ claim_id: "critic:qa-e2e:flaky", final_status: "defer", missing: ["a second E2E run"], evidence: [] }));
    const accepted = write(criticRec({ claim_id: "critic:security:token" }));
    const unheld = write(criticRec({ claim_id: "critic:ux-flow:unheld", final_status: "revise", repair: "restate it" }));
    const refless = write(criticRec({ claim_id: "critic:ux-flow:refless", final_status: "revise", repair: "restate it" }));
    act(refless, "HOLD", "", "critic-round"); // a review-only round's HOLD names no node
    for (const [rec, node] of [[revise, "LP-001"], [reject, "LP-002"], [human, "LP-003"], [evidence, "LP-004"], [accepted, "LP-005"]]) act(rec, "HOLD", node);
    const esc = (id, record) => row(id, { status: "escalated", record, missing: "a human decision", origin: `critic rec:${record}` });
    const { errors } = lint([
      esc("LP-001", revise),
      esc("LP-002", reject),
      esc("LP-003", human),
      esc("LP-004", evidence),
      esc("LP-005", accepted),
      esc("LP-006", unheld),
      esc("LP-007", refless), // HOLDed, but for no node
      esc("LP-008", revise), // HOLDed, but for LP-001
    ]);
    expect(flagged(errors, "escalated-record")).toEqual(["LP-004", "LP-005", "LP-006", "LP-007", "LP-008"]);
    expect(rulesOf(errors).every((r) => r === "escalated-record")).toBe(true);
  });

  it("4 or more loop:<id> defers on a node that is still ready, blocked or deferred is an error (agent-failed defers count)", () => {
    // Each node's first defer is an agent-failed one (an infra failure the loop reset without new evidence).
    const defers = (id, n) => Array.from({ length: n }, (_, i) => write(deferRec(id, `evidence ${i}`, i === 0 ? { failed_gates: ["agent-failed"] } : {})));
    const four = defers("LP-001", 4);
    const three = defers("LP-002", 3);
    act(three[2], "HOLD", "LP-002");
    const fourEscalated = defers("LP-003", 4);
    act(fourEscalated[3], "HOLD", "LP-003");
    const fourDeferred = defers("LP-004", 4); // set deferred again on its fourth defer, instead of escalated
    act(fourDeferred[3], "HOLD", "LP-004");
    const fourBlocked = defers("LP-005", 4); // reset after its fourth defer; it now waits on LP-002
    const { errors } = lint([
      row("LP-001", { record: four[3], missing: "evidence 3", notes: `attempt 4; reset citing ${four[3]}` }),
      row("LP-002", { status: "deferred", record: three[2], missing: "evidence 2", notes: "attempt 3" }),
      row("LP-003", { status: "escalated", record: fourEscalated[3], missing: "a human decision after 4 attempts" }),
      row("LP-004", { status: "deferred", record: fourDeferred[3], missing: "evidence 3", notes: "attempt 4" }),
      row("LP-005", { after: "LP-002", status: "blocked", record: fourBlocked[3], missing: "evidence 3", notes: `attempt 4; reset citing ${fourBlocked[3]}` }),
    ]);
    expect(rulesOf(errors)).toEqual(["attempts", "attempts", "attempts"]);
    expect(flagged(errors, "attempts")).toEqual(["LP-001", "LP-004", "LP-005"]);
  });

  it("in-progress is a warning by default and an error with preDispatch", () => {
    const rows = [row("LP-001", { status: "in-progress" })];
    const plain = lint(rows);
    expect(plain.errors).toEqual([]);
    expect(flagged(plain.warnings, "in-progress")).toEqual(["LP-001"]);
    expect(rulesOf(lint(rows, { preDispatch: true }).errors)).toEqual(["in-progress"]);
  });

  it("a critic-origin node reset to ready keeps its record and missing; plan-items passes its missing on, never the critic record as priorRecordId", () => {
    const finding = write(criticRec({ final_status: "defer", missing: ["an E2E run of the cleared-name path"], evidence: [] }));
    act(finding, "HOLD", "LP-001");
    const arrived = write(criticRec({ claim_id: "critic:qa-e2e:e2e-run", claim_text: "The cleared-name E2E run passes", evidence: [{ kind: "command", ref: "pnpm test:e2e", result: "1 passed" }] }));
    const cells = { record: finding, missing: "an E2E run of the cleared-name path", origin: `critic:qa-e2e rec:${finding}` };
    expect(lint([row("LP-001", { ...cells, status: "deferred" })])).toEqual({ errors: [], warnings: [] });
    const reset = [row("LP-001", { ...cells, notes: `reset: ${arrived} supplies the E2E run` })];
    expect(lint(reset)).toEqual({ errors: [], warnings: [] });
    // loop-iteration writes the new verdict with `revises: priorRecordId`. A critic record passed on would be
    // superseded across claims (critic:… → loop:lp-001) and drop out of the next round's --latest priors while still open.
    expect(planItems(plan(...reset).nodes, ["LP-001"], replayed())).toEqual({
      items: [{ id: "LP-001", description: "work for LP-001", missing: "an E2E run of the cleared-name path" }],
      refused: [],
    });
  });

  it("plan-items passes a node's record on as priorRecordId only when it is the node's own loop:<id> record", () => {
    const own = write(deferRec("LP-001", "a unit test run"));
    act(own, "HOLD", "LP-001");
    const ancestor = write(loopRec("LP-002", { final_status: "reject", reason: "touches the auth flow" }));
    act(ancestor, "HOLD", "LP-002");
    const p = plan(
      row("LP-001", { record: own, missing: "a unit test run", notes: `reset: ${own} was agent-failed` }),
      // A cascade-escalated node a human reset to ready still cites its ancestor's record (claim loop:lp-002).
      row("LP-003", { record: ancestor, missing: "the human decision LP-002 waited on", origin: "cascade from LP-002" }),
      row("LP-004", { record: "TR-0123456789ab", missing: "a unit test run" }), // not in the store
    );
    expect(planItems(p.nodes, ["LP-001", "LP-003", "LP-004"], replayed()).items).toEqual([
      { id: "LP-001", description: "work for LP-001", priorRecordId: own, missing: "a unit test run" },
      { id: "LP-003", description: "work for LP-003", missing: "the human decision LP-002 waited on" },
      { id: "LP-004", description: "work for LP-004", missing: "a unit test run" },
    ]);
    // Without a replayed store nothing shows whose record it is, so none is passed on (fail closed).
    expect(planItems(p.nodes, ["LP-001"]).items).toEqual([{ id: "LP-001", description: "work for LP-001", missing: "a unit test run" }]);
  });

  it("a node that is not done while its loop:<id> claim carries a CLEAR warns [reused-id] (ids are never reused, a pruned one included)", () => {
    const old = write(loopRec("LP-001"));
    act(old, "CLEAR", "LP-001"); // LP-001 was done, then pruned from the table
    const reused = lint([row("LP-001", { description: "new work that reuses the pruned id" }), row("LP-002")]);
    expect(reused.errors).toEqual([]);
    expect(rulesOf(reused.warnings)).toEqual(["reused-id"]);
    expect(flagged(reused.warnings, "reused-id")).toEqual(["LP-001"]);
    expect(lint([row("LP-001", { status: "done", record: old })])).toEqual({ errors: [], warnings: [] });
    // Only a CLEAR shows the id was done: a node's own HOLDed defer is the normal re-dispatch path.
    const held = write(deferRec("LP-003", "a unit test run"));
    act(held, "HOLD", "LP-003");
    expect(lint([row("LP-003", { status: "deferred", record: held, missing: "a unit test run" })])).toEqual({ errors: [], warnings: [] });
  });
});

describe("plan-items", () => {
  it("each item carries only {id, description, priorRecordId?, missing?} — the shape the bench measured", () => {
    const p = plan(
      row("LP-001", { description: "add the E2E", origin: "critic:qa-e2e", notes: "n" }),
      row("LP-002", { after: "LP-003", record: "TR-0123456789ab", missing: "a unit test run", origin: "critic", notes: "reset citing TR-abcdefabcdef" }),
      row("LP-003", { status: "done" }),
    );
    // LP-002's record is its own loop:lp-002 record (the replayed store's records map; the real-store cases are above).
    const state = { records: new Map([["TR-0123456789ab", { record_id: "TR-0123456789ab", claim_id: "loop:lp-002" }]]) };
    const { items, refused } = planItems(p.nodes, ["LP-001", "LP-002"], state);
    expect(refused).toEqual([]);
    expect(items).toEqual([
      { id: "LP-001", description: "add the E2E" },
      { id: "LP-002", description: "work for LP-002", priorRecordId: "TR-0123456789ab", missing: "a unit test run" },
    ]);
    for (const item of items) expect(Object.keys(item).filter((k) => !["id", "description", "priorRecordId", "missing"].includes(k))).toEqual([]);
  });

  it("a non-ready id is refused, and then no item is emitted (all or nothing)", () => {
    const p = plan(row("LP-001"), row("LP-002", { after: "LP-001", status: "blocked" }), row("LP-003", { status: "deferred", missing: "m" }), row("LP-004", { status: "in-progress" }));
    for (const id of ["LP-002", "LP-003", "LP-004", "LP-404"]) {
      const res = planItems(p.nodes, ["LP-001", id]);
      expect(res.items, id).toEqual([]);
      expect(res.refused.map((r) => r.id), id).toEqual([id]);
    }
    expect(planItems(p.nodes, ["LP-001", "LP-001"]).refused.map((r) => r.id)).toEqual(["LP-001"]);
  });
});
