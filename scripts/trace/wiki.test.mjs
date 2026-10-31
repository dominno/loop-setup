// Wiki ↔ store agreement — `pnpm trace wiki-check`: every fact a topic page cites is on record and
// committed to that page, every committed fact is still cited, quarantine.md lists exactly the
// QUARANTINEd candidates, and the always-loaded index stays small. The store is built with the real
// writer (writeRecords / appendActions), so every record and action below passed the gates a /dream
// ingest faces; the pages are plain text, as loadWiki reads them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WIKI_LIMITS,
  appendActions,
  loadEntries,
  loadSchema,
  loadWiki,
  readPolicyVersion,
  reauditCandidates,
  replay,
  wikiViolations,
  writeRecords,
} from "./lib.mjs";

const schema = loadSchema();
const POLICY = readPolicyVersion();
const COMMIT = "abc1234def56";
let dir;
let store;
let tick;
// Each write is a second after the last: latestByClaim orders a claim's records by created_at.
const ctx = () => ({ storePath: store, now: new Date(Date.UTC(2026, 9, 30, 12, 0, (tick += 1))).toISOString(), policyVersion: POLICY, commit: COMMIT, schema });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-wiki-"));
  store = join(dir, "records.jsonl");
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = "topics/testing.md";
const fact = (over = {}) => ({
  writer_id: "dream",
  claim_id: "wiki:testing:file-parallelism",
  claim_text: "Vitest runs test files in parallel by default",
  claim_type: "factual",
  evidence: [{ kind: "file_line", ref: "vitest.config.ts:8" }],
  final_status: "accept",
  reason: "read this session",
  provenance: { workflow: "dream" },
  ...over,
});
/** Store one draft through the real writer (its gates apply) and return the record id. */
const write = (over) => {
  const [r] = writeRecords([fact(over)], ctx());
  expect(r.validation).toBe("pass");
  return r.record_id;
};
/** Append one /dream consumer action; true when the writer stored it. */
const act = (record_id, action, ref) => appendActions([{ record_id, consumer: "dream", action, ...(ref ? { ref } : {}) }], ctx())[0].stored;
/** A topic page: a heading, a blank line, then the bullets — so the first bullet is line 3. */
const page = (path, ...bullets) => ({ path, text: ["# Testing conventions", "", ...bullets, ""].join("\n") });
const cite = (id, text = "a fact") => `- ${text} <!-- rec:${id} -->`;
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const check = (wiki = {}) => wikiViolations({ pages: [], quarantine: null, index: null, ...wiki, state: replay(loadEntries(store), schema, POLICY) });
const quarantineTable = (...ids) =>
  ["# Memory quarantine", "", "| record | candidate fact | missing (what would admit it) | since |", "|---|---|---|---|", ...ids.map((id) => `| ${id} | a candidate | a reproduction | 2026-10-30 |`), ""].join("\n");

describe("wikiViolations: the wiki and the record store agree", () => {
  it("an empty wiki with an empty store is clean", () => {
    expect(check()).toEqual({ errors: [], warnings: [] });
  });

  it("a committed fact cited by its page is clean (an action ref may carry the .claude/memory/ prefix)", () => {
    const id = write();
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    expect(check({ pages: [page(PAGE, cite(id))] })).toEqual({ errors: [], warnings: [] });
    const q = write({ claim_id: "wiki:testing:announcer", claim_text: "Next injects a route announcer with role=alert", final_status: "qualify", qualifier: "observed on Next 16" });
    expect(act(q, "COMMIT_QUALIFIED", `.claude/memory/${PAGE}`)).toBe(true);
    expect(check({ pages: [page(PAGE, cite(id), cite(q))] })).toEqual({ errors: [], warnings: [] });
  });

  it("only the comment form cites: rec:TR-000000000000 names no record (and the message names the adopter's fix); an id in prose is no citation", () => {
    const { errors } = check({ pages: [page(PAGE, cite("TR-000000000000"), "- tight <!--rec:TR-222222222222-->", "- prose naming rec:TR-111111111111 cites nothing")] });
    expect(errors.map((e) => e.split(" names no record")[0])).toEqual(["topics/testing.md:3: rec:TR-000000000000", "topics/testing.md:4: rec:TR-222222222222"]);
    expect(errors.every((e) => /strip the comment and keep the fact as a legacy bullet/.test(e))).toBe(true);
  });

  it("a COMMIT ref to another page gives an error that names where the record is committed", () => {
    const id = write();
    expect(act(id, "COMMIT", "topics/other.md")).toBe(true);
    const { errors } = check({ pages: [page(PAGE, cite(id)), page("topics/other.md")] });
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`topics/testing.md:3: rec:${id} has no COMMIT/COMMIT_QUALIFIED action with --ref topics/testing.md`)).toBe(true);
    expect(errors[0]).toContain("committed to topics/other.md");
  });

  it("a bullet citing a record that a reject revised gives 'superseded'; one citing a record with a newer verdict for its claim gives 'not the latest'", () => {
    const id = write();
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    const rej = write({ final_status: "reject", reason: "Vitest now runs files serially by default", revises: id, evidence: [{ kind: "command", ref: "pnpm exec vitest --version" }] });
    const superseded = check({ pages: [page(PAGE, cite(id))] }).errors;
    expect(superseded).toHaveLength(1);
    expect(superseded[0].startsWith(`topics/testing.md:3: rec:${id} is superseded: ${rej} revises it`)).toBe(true);
    // A re-adjudication written without `revises` still outdates the record a bullet cites.
    const old = write({ claim_id: "wiki:testing:announcer", claim_text: "Next injects a route announcer" });
    expect(act(old, "COMMIT", PAGE)).toBe(true);
    const newer = write({ claim_id: "wiki:testing:announcer", claim_text: "Next injects a route announcer with role=alert" });
    const stale = check({ pages: [page(PAGE, cite(old))] }).errors;
    expect(stale).toHaveLength(1);
    expect(stale[0].startsWith(`topics/testing.md:3: rec:${old} is not the latest record for wiki:testing:announcer: ${newer} is newer`)).toBe(true);
  });

  it("a cited record that does not license a fact (a defer) gives an error", () => {
    const d = write({ final_status: "defer", missing: ["a local reproduction"], evidence: [{ kind: "reading", ref: "external:https://example.com/post" }] });
    const { errors } = check({ pages: [page(PAGE, cite(d))] });
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`topics/testing.md:3: rec:${d} is a "defer" record`)).toBe(true);
  });

  it("a committed fact that no page cites is an error when its ref is a topics/ page (even one since deleted); a ref outside topics/, such as a bridged domain wiki, is ignored", () => {
    const kept = write();
    const gone = write({ claim_id: "wiki:old:x", claim_text: "a fact on a page that was deleted" });
    const bridged = write({ claim_id: "wiki:domain:billing", claim_text: "a domain fact filed into the bridged wiki" });
    expect(act(kept, "COMMIT", PAGE)).toBe(true);
    expect(act(gone, "COMMIT", "topics/old.md")).toBe(true);
    expect(act(bridged, "COMMIT", "docs/wiki/billing.md")).toBe(true);
    const { errors } = check({ pages: [page(PAGE)] });
    expect(errors.map((e) => e.split(" but no topic page cites it")[0])).toEqual([
      `${kept} (wiki:testing:file-parallelism) is committed to topics/testing.md`,
      `${gone} (wiki:old:x) is committed to topics/old.md`,
    ]);
    expect(errors.every((e) => /never a silent delete/.test(e))).toBe(true);
  });

  it("quarantine.md rows and the latest QUARANTINEd records agree, in both directions", () => {
    const d = write({ claim_id: "wiki:workflow:scratch", claim_text: "subagents can remove each other's scratch worktrees", final_status: "defer", missing: ["a reproduction"], evidence: [] });
    expect(act(d, "QUARANTINE", "quarantine.md")).toBe(true);
    expect(check({ quarantine: quarantineTable(d) })).toEqual({ errors: [], warnings: [] });
    // A QUARANTINEd record with no row (a missing quarantine.md has no rows).
    for (const quarantine of [quarantineTable(), null]) {
      const { errors } = check({ quarantine });
      expect(errors).toHaveLength(1);
      expect(errors[0].startsWith(`${d} (wiki:workflow:scratch) is QUARANTINEd but quarantine.md has no row for it`)).toBe(true);
    }
    // Rows that name no record, or a record that was never quarantined.
    const acc = write();
    const rows = check({ quarantine: quarantineTable(d, "TR-000000000000", acc) }).errors;
    expect(rows.map((e) => e.split(" — ")[0])).toEqual(["quarantine.md:6: TR-000000000000 names no record in the store", `quarantine.md:7: ${acc} has no QUARANTINE action`]);
    // Re-adjudicated (promoted by a revising record): its row goes.
    const promoted = write({ claim_id: "wiki:workflow:scratch", claim_text: "subagents can remove each other's scratch worktrees", revises: d, evidence: [{ kind: "command", ref: "bash repro.sh" }] });
    const readjudicated = check({ quarantine: quarantineTable(d) }).errors;
    expect(readjudicated).toHaveLength(1);
    expect(readjudicated[0].startsWith(`quarantine.md:5: ${d} was re-adjudicated: ${promoted} is newer`)).toBe(true);
    expect(check({ quarantine: quarantineTable() }).errors).toEqual([]);
  });

  it("index.md over 150 lines is an error; a topic page over 200 lines is a warning, and the policy page's limit is 400", () => {
    expect(WIKI_LIMITS).toEqual({ indexMaxLines: 150, pageMaxLines: 200, policyPage: "topics/trace.md", policyPageMaxLines: 400 });
    expect(check({ index: lines(150) })).toEqual({ errors: [], warnings: [] });
    const index = check({ index: lines(151) }).errors;
    expect(index).toHaveLength(1);
    expect(index[0].startsWith("index.md: 151 lines (> 150)")).toBe(true);
    const sized = check({ pages: [{ path: "topics/big.md", text: lines(201) }, { path: "topics/ok.md", text: lines(200) }, { path: "topics/trace.md", text: lines(292) }] });
    expect(sized.errors).toEqual([]);
    expect(sized.warnings).toHaveLength(1);
    expect(sized.warnings[0].startsWith("topics/big.md: 201 lines (> 200)")).toBe(true);
    const policy = check({ pages: [{ path: "topics/trace.md", text: lines(401) }] }).warnings;
    expect(policy).toHaveLength(1);
    expect(policy[0].startsWith("topics/trace.md: 401 lines (> 400)")).toBe(true);
  });
});

// dream.md lint 1e: the record first, then the page edit, then the consumer action — and each flow
// ends with the wiki and the store in agreement.
describe("/dream's retire, rewrite and move flows end clean", () => {
  it("(i) retire a recorded fact: a reject record that revises it, the bullet removed, then REJECT", () => {
    const id = write();
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    const rej = write({ final_status: "reject", reason: "Vitest now runs files serially by default", revises: id, evidence: [{ kind: "command", ref: "pnpm exec vitest --version" }] });
    expect(check({ pages: [page(PAGE, cite(id))] }).errors.join("\n")).toMatch(/is superseded/); // the bullet still cites it
    expect(check({ pages: [page(PAGE)] }).errors).toEqual([]);
    expect(act(rej, "REJECT")).toBe(true);
    expect(check({ pages: [page(PAGE)] })).toEqual({ errors: [], warnings: [] });
  });

  it("(ii) rewrite a recorded fact: a new accept/qualify record that revises it, the bullet citing the new id, then COMMIT/COMMIT_QUALIFIED", () => {
    const id = write();
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    const text = "Vitest runs test files in parallel unless fileParallelism is false";
    const v2 = write({ claim_text: text, final_status: "qualify", qualifier: "the default config; a project may turn it off", revises: id });
    expect(check({ pages: [page(PAGE, cite(id))] }).errors.join("\n")).toMatch(/is superseded/); // not rewritten yet
    const rewritten = [page(PAGE, cite(v2, text))];
    expect(check({ pages: rewritten }).errors.join("\n")).toMatch(/has no COMMIT\/COMMIT_QUALIFIED action/); // not acted on yet
    expect(act(v2, "COMMIT", PAGE)).toBe(false); // COMMIT is accept-only: a qualify takes COMMIT_QUALIFIED
    expect(act(v2, "COMMIT_QUALIFIED", PAGE)).toBe(true);
    expect(check({ pages: rewritten })).toEqual({ errors: [], warnings: [] });
  });

  it("a rewrite is never a revise record: neither COMMIT action is allowed on one", () => {
    const id = write();
    const rev = write({ final_status: "revise", repair: "restate it for the configured default", revises: id });
    expect(act(rev, "COMMIT", PAGE)).toBe(false);
    expect(act(rev, "COMMIT_QUALIFIED", PAGE)).toBe(false);
  });

  it("(iii) rewrite a legacy bullet: a new accept/qualify record with no revises, the rec comment added, then COMMIT", () => {
    const text = "Playwright webServer reuses an already-running dev server";
    expect(check({ pages: [page(PAGE, `- ${text}`)] })).toEqual({ errors: [], warnings: [] }); // a legacy bullet predates TRACE: not checked
    const id = write({ claim_id: "wiki:testing:webserver-reuse", claim_text: text, evidence: [{ kind: "file_line", ref: "playwright.config.ts:20" }] });
    const tagged = [page(PAGE, cite(id, text))];
    expect(check({ pages: tagged }).errors.join("\n")).toMatch(/has no COMMIT\/COMMIT_QUALIFIED action/);
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    expect(check({ pages: tagged })).toEqual({ errors: [], warnings: [] });
  });

  it("moving a fact to another page is a COMMIT with the new --ref", () => {
    const id = write();
    expect(act(id, "COMMIT", PAGE)).toBe(true);
    const moved = [page(PAGE), page("topics/vitest.md", cite(id))];
    const before = check({ pages: moved }).errors;
    expect(before).toHaveLength(1);
    expect(before[0].startsWith(`topics/vitest.md:3: rec:${id} has no COMMIT/COMMIT_QUALIFIED action with --ref topics/vitest.md`)).toBe(true);
    expect(act(id, "COMMIT", "topics/vitest.md")).toBe(true);
    expect(check({ pages: moved })).toEqual({ errors: [], warnings: [] });
  });
});

describe("loadWiki", () => {
  it("reads every topics/*.md page (sorted, named relative to the memory dir), quarantine.md and index.md; a missing file or directory is tolerated", () => {
    const mem = join(dir, "memory");
    mkdirSync(mem);
    expect(loadWiki(mem)).toEqual({ pages: [], quarantine: null, index: null });
    mkdirSync(join(mem, "topics"));
    writeFileSync(join(mem, "topics", "b.md"), "# B\n");
    writeFileSync(join(mem, "topics", "a.md"), "# A\n");
    writeFileSync(join(mem, "topics", "notes.txt"), "not a page\n");
    writeFileSync(join(mem, "index.md"), "# Index\n");
    expect(loadWiki(mem)).toEqual({ pages: [{ path: "topics/a.md", text: "# A\n" }, { path: "topics/b.md", text: "# B\n" }], quarantine: null, index: "# Index\n" });
  });
});

// The temp-repo end of this (a commit squashed away and pruned) is in cli.test.mjs.
describe("reauditCandidates: a record whose provenance commit is unreachable", () => {
  it("is listed apart, with `unreachable` and every cited path, and never diffed (one citing no file has nothing to re-check)", () => {
    const gone = write({ evidence: [{ kind: "file_line", ref: "vitest.config.ts:8" }, { kind: "diff", ref: "src/a.ts, src/b.ts" }], provenance: { workflow: "dream", commit: "0123456789ab" } });
    write({ claim_id: "wiki:testing:no-file", claim_text: "pnpm test runs vitest", evidence: [{ kind: "command", ref: "pnpm test" }], provenance: { workflow: "dream", commit: "0123456789ab" } });
    const kept = write({ claim_id: "wiki:testing:announcer", claim_text: "Next injects a route announcer", evidence: [{ kind: "file_line", ref: "e2e/a.spec.ts:3" }] });
    const st = replay(loadEntries(store), schema, POLICY);
    const diffed = [];
    const changedSince = (commit, path) => {
      diffed.push(commit);
      return path === "e2e/a.spec.ts";
    };
    expect(reauditCandidates(st.records, st.superseded, changedSince, (commit) => commit !== "0123456789ab")).toEqual([
      { record_id: gone, claim_id: "wiki:testing:file-parallelism", claim_text: "Vitest runs test files in parallel by default", unreachable: "0123456789ab", paths: ["vitest.config.ts", "src/a.ts", "src/b.ts"] },
      { record_id: kept, claim_id: "wiki:testing:announcer", claim_text: "Next injects a route announcer", changed: ["e2e/a.spec.ts"] },
    ]);
    expect(diffed).toEqual([COMMIT]);
  });
});
