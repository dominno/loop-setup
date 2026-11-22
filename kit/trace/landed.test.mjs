// The landed predicate is pure: what a done node's CLEAR recorded, a human LAND, and facts the git
// adapter supplies decide whether its change is in HEAD. No git, fs or env here.
import { describe, expect, it } from "vitest";
import { landedMap, landedStatus, landingOf, nodeLanding } from "./landed.mjs";
import { parsePlan, planItems, planViolations, readyIds } from "./plan.mjs";

const PID = "0123456789abcdef0123456789abcdef01234567";

describe("landingOf (the CLEAR note's tokens)", () => {
  it("reads base, patch-id and commit, in any order and next to free text", () => {
    expect(landingOf(`base abc1234; patch 0a1b2c3d4e5f; patch-id ${PID}; commit fedcba9876543; pnpm test passed; qualifier x`)).toEqual({ base: "abc1234", patchId: PID, commit: "fedcba9876543" });
    expect(landingOf(`patch-id ${PID}; base abc1234def56`)).toEqual({ base: "abc1234def56", patchId: PID, commit: null });
  });
  it("a note before this change (base and patch hash only) or junk has neither patch-id nor commit", () => {
    expect(landingOf("base abc1234; patch 0a1b2c3d4e5f; pnpm test passed")).toEqual({ base: "abc1234", patchId: null, commit: null });
    expect(landingOf("")).toEqual({ base: null, patchId: null, commit: null });
    expect(landingOf(undefined)).toEqual({ base: null, patchId: null, commit: null });
    expect(landingOf("patch-id nothex; commit zz")).toEqual({ base: null, patchId: null, commit: null });
  });
});

describe("landedStatus (the landed table)", () => {
  const clear = { base: "abc1234", patchId: PID, commit: null };
  it("a human LAND lands it, whatever git says", () => {
    expect(landedStatus({ clear, land: true }, { ancestor: false, patchId: false, trailer: false })).toEqual({ status: "landed", why: "human" });
  });
  it("an ancestor commit, a matching patch-id in HEAD's history, or a Plan trailer lands it", () => {
    expect(landedStatus({ clear: { ...clear, commit: "fedcba9" }, land: false }, { ancestor: true })).toMatchObject({ status: "landed", why: "ancestor" });
    expect(landedStatus({ clear, land: false }, { ancestor: false, patchId: true })).toMatchObject({ status: "landed", why: "patch-id" });
    expect(landedStatus({ clear, land: false }, { ancestor: false, patchId: false, trailer: true })).toMatchObject({ status: "landed", why: "trailer" });
  });
  it("otherwise it is unknown — never 'not landed', and 'git cannot tell' is unknown too", () => {
    expect(landedStatus({ clear, land: false }, { ancestor: false, patchId: false, trailer: false })).toMatchObject({ status: "unknown", why: "not in HEAD's history" });
    expect(landedStatus({ clear, land: false }, { ancestor: null, patchId: null, trailer: null })).toMatchObject({ status: "unknown", why: "git cannot tell" });
    expect(landedStatus({ clear, land: false }, {})).toMatchObject({ status: "unknown" });
  });
  it("a done node recorded before this change (no patch-id, no commit) counts as landed, flagged legacy", () => {
    expect(landedStatus({ clear: { base: "abc1234", patchId: null, commit: null }, land: false }, {})).toEqual({ status: "landed", why: "legacy" });
    expect(landedStatus({ clear: null, land: false }, {})).toEqual({ status: "landed", why: "legacy" });
  });
});

// A plan with LP-aaaa done (its CLEAR carries a patch-id) and LP-bbbb after it.
const TABLE = `## Plan

| id | description | after | status | record | missing | origin | notes | scope | check |
|---|---|---|---|---|---|---|---|---|---|
| LP-aaaa | First — done when: x | — | done | TR-aaaaaaaaaaaa | — | human | — | src/a.ts | pnpm test |
| LP-bbbb | Second — done when: y | LP-aaaa | blocked | — | — | human | — | src/b.ts | pnpm test |
`;
const rec = { record_id: "TR-aaaaaaaaaaaa", claim_id: "loop:lp-aaaa", final_status: "accept", writer_id: "loop-iteration/verify:LP-aaaa-0" };
const stateWith = (actions) => ({ records: new Map([[rec.record_id, rec]]), actions: new Map([[rec.record_id, actions]]), superseded: new Set(), latestOfClaim: new Map([[rec.claim_id, rec.record_id]]) });
const CLEAR = { action: "CLEAR", consumer: "loop", ref: "LP-aaaa", note: `base abc1234; patch 0a1b2c3d4e5f; patch-id ${PID}; pnpm test passed` };

describe("nodeLanding and landedMap (the port's composition)", () => {
  const { nodes } = parsePlan(TABLE);
  it("nodeLanding reads the node's own CLEAR (ref = the node) and a human LAND on its record", () => {
    expect(nodeLanding(nodes[0], stateWith([CLEAR]))).toEqual({ id: "LP-aaaa", clear: { base: "abc1234", patchId: PID, commit: null }, land: false });
    expect(nodeLanding(nodes[0], stateWith([CLEAR, { action: "LAND", consumer: "human", ref: "LP-aaaa", note: "squashed with LP-dddd" }])).land).toBe(true);
    expect(nodeLanding(nodes[0], stateWith([CLEAR, { action: "LAND", consumer: "loop", ref: "LP-aaaa" }])).land).toBe(false); // only a human lands it
    expect(nodeLanding(nodes[0], stateWith([CLEAR, { action: "LAND", consumer: "human", ref: "LP-cccc" }])).land).toBe(false); // another node's
  });
  it("landedMap asks the facts port once per done node and decides with the table", () => {
    const asked = [];
    const m = landedMap(nodes, stateWith([CLEAR]), (q) => (asked.push(q), { ancestor: false, patchId: q.patchId === PID, trailer: false }));
    expect(asked).toEqual([{ id: "LP-aaaa", base: "abc1234", patchId: PID, commit: null }]);
    expect(m.get("LP-aaaa")).toMatchObject({ status: "landed", why: "patch-id" });
    expect(m.has("LP-bbbb")).toBe(false);
  });
});

describe("the landed port in readyIds, planItems and planViolations", () => {
  const plan = parsePlan(TABLE);
  const unlanded = new Map([["LP-aaaa", { status: "unknown", why: "not in HEAD's history" }]]);
  const landed = new Map([["LP-aaaa", { status: "landed", why: "patch-id" }]]);
  it("only a landed done node satisfies after", () => {
    expect(readyIds(plan.nodes, { landed })).toEqual(["LP-bbbb"]);
    expect(readyIds(plan.nodes, { landed: unlanded })).toEqual([]);
    expect(readyIds(plan.nodes, { landed: new Map() })).toEqual([]); // a done node the port did not settle is not landed (fail safe)
    expect(readyIds(plan.nodes)).toEqual(["LP-bbbb"]); // no port: today's behaviour
  });
  it("planItems refuses a node that waits on a done but unlanded node, naming why", () => {
    const r = planItems(plan.nodes, ["LP-bbbb"], stateWith([CLEAR]), { landed: unlanded });
    expect(r.items).toEqual([]);
    expect(r.refused[0].reason).toMatch(/waits on LP-aaaa \(done, not landed in HEAD\)/);
    expect(planItems(plan.nodes, ["LP-bbbb"], stateWith([CLEAR]), { landed }).items.map((i) => i.id)).toEqual(["LP-bbbb"]);
  });
  it("plan-lint warns [done-unlanded] and [done-legacy], never errors for them", () => {
    const v = planViolations(plan, stateWith([CLEAR]), { landed: unlanded });
    expect(v.warnings.join("\n")).toMatch(/\[done-unlanded\] .*LP-aaaa.*not in HEAD's history/);
    expect(v.errors.join("\n")).not.toMatch(/done-unlanded/);
    const legacy = planViolations(plan, stateWith([CLEAR]), { landed: new Map([["LP-aaaa", { status: "landed", why: "legacy" }]]) });
    expect(legacy.warnings.join("\n")).toMatch(/\[done-legacy\] .*LP-aaaa/);
    expect(planViolations(plan, stateWith([CLEAR]), { landed }).warnings.join("\n")).not.toMatch(/done-unlanded|done-legacy/);
  });
});
