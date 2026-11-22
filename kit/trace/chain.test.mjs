// The record chain core is pure: digests, per-writer chains and checkpoints decided from store
// entries ({ source, line, raw, value }) and anchors alone. No fs, git, clock or env here.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { advancedCheckpoints, anchorViolations, chainBatch, chainViolations, checkpointsFor, lineDigest, nextChain, parseAnchors, walkChains } from "./chain.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const W1 = "aaaaaaaaaaaaaaaa";
const W2 = "bbbbbbbbbbbbbbbb";

/** Build a store as entries: each spec is { w } (chained) or {} (an unchained 1.0 line), in order. */
function store(specs) {
  const lastOf = new Map();
  return specs.map((s, i) => {
    const value = s.w
      ? { kind: "record", schema_version: "trace-lite/1.1", record_id: `TR-${String(i).padStart(12, "0")}`, chain: { w: s.w, prev: s.prev !== undefined ? s.prev : lastOf.get(s.w) || null } }
      : { kind: "record", schema_version: "trace-lite/1.0", record_id: `TR-${String(i).padStart(12, "0")}` };
    const raw = JSON.stringify(value);
    if (s.w) lastOf.set(s.w, lineDigest(raw));
    return { source: "records.jsonl", line: i + 1, raw, value };
  });
}
const without = (entries, i) => entries.filter((_, j) => j !== i);

describe("lineDigest", () => {
  it("is the sha256 of the line exactly as stored", () => {
    expect(lineDigest('{"a":1}')).toBe(sha('{"a":1}'));
    expect(lineDigest('{"a":1}')).not.toBe(lineDigest('{"a": 1}'));
  });
});

describe("nextChain", () => {
  it("points at the digest of the writer's own last line, or null for its first", () => {
    const s = store([{}, { w: W1 }, { w: W2 }, { w: W1 }]);
    expect(nextChain(s, W1)).toEqual({ w: W1, prev: lineDigest(s[3].raw) });
    expect(nextChain(s, W2)).toEqual({ w: W2, prev: lineDigest(s[2].raw) });
    expect(nextChain(s, "cccccccccccccccc")).toEqual({ w: "cccccccccccccccc", prev: null });
    expect(nextChain([], W1)).toEqual({ w: W1, prev: null });
  });
});

describe("chainViolations", () => {
  it("an unchained prefix followed by interleaved writers is clean", () => {
    expect(chainViolations(store([{}, {}, { w: W1 }, { w: W2 }, { w: W1 }, { w: W2 }, { w: W2 }]))).toEqual([]);
    expect(chainViolations([])).toEqual([]);
  });

  it("interleaving the writers differently (a union merge or a rebase) keeps every chain", () => {
    const s = store([{ w: W1 }, { w: W1 }, { w: W2 }, { w: W2 }]);
    const reordered = [s[2], s[0], s[3], s[1]]; // each writer's own order kept
    expect(chainViolations(reordered)).toEqual([]);
  });

  it("deleting a writer's middle line breaks its successor's prev", () => {
    const s = store([{ w: W1 }, { w: W2 }, { w: W1 }, { w: W1 }]);
    const v = chainViolations(without(s, 2));
    expect(v.join("\n")).toMatch(/records\.jsonl:4: .*prev .* writer aaaaaaaaaaaaaaaa/);
  });

  it("editing a writer's middle line breaks its successor's prev", () => {
    const s = store([{ w: W1 }, { w: W1 }, { w: W1 }]);
    const edited = s.map((e, i) => (i === 1 ? { ...e, raw: e.raw.replace("TR-", "TR-x") } : e));
    expect(chainViolations(edited).length).toBeGreaterThan(0);
  });

  it("a writer's first line must have prev null, and a fork (two lines with one prev) is refused", () => {
    expect(chainViolations(store([{ w: W1, prev: "f".repeat(64) }])).join()).toMatch(/prev/);
    const s = store([{ w: W1 }]);
    const fork = store([{ w: W1 }, { w: W1, prev: null }]);
    expect(chainViolations([s[0], fork[1]]).length).toBeGreaterThan(0);
  });

  it("an unchained line after the first chained line is a warning (an older kit wrote it), never an error", () => {
    const s = store([{}, { w: W1 }, {}]);
    expect(chainViolations(s)).toEqual([]);
    expect(walkChains(s).warnings.join()).toMatch(/records\.jsonl:3: .*unchained .*upgrade every machine/);
  });
});

describe("lineDigest and CRLF", () => {
  it("one trailing \\r is not part of the digest (a CRLF checkout keeps every chain)", () => {
    expect(lineDigest('{"a":1}\r')).toBe(lineDigest('{"a":1}'));
  });
});

describe("chainBatch", () => {
  it("starts from the writer's last stored line and threads prev through the lines it finalizes", () => {
    const s = store([{ w: W1 }, { w: W2 }]);
    const finalize = (it) => ({ ...it, record_id: `TR-${it.n}` });
    const out = chainBatch(nextChain(s, W1), [{ n: 1 }, { n: 2 }], finalize);
    expect(out[0].chain).toEqual({ w: W1, prev: lineDigest(s[0].raw) });
    expect(out[1].chain).toEqual({ w: W1, prev: lineDigest(JSON.stringify(out[0])) });
    const appended = [...s, ...out.map((v, i) => ({ source: "records.jsonl", line: 3 + i, raw: JSON.stringify(v), value: v }))];
    expect(chainViolations(appended)).toEqual([]);
  });
});

describe("checkpoints and anchors", () => {
  it("checkpointsFor: the legacy prefix as a sorted id set, and each writer's count and last digest", () => {
    const s = store([{}, {}, { w: W2 }, { w: W1 }, { w: W2 }]);
    expect(checkpointsFor(s)).toEqual([
      { w: null, n: 2, ids: [s[0].value.record_id, s[1].value.record_id].sort() },
      { w: W1, n: 1, sha: lineDigest(s[3].raw) },
      { w: W2, n: 2, sha: lineDigest(s[4].raw) },
    ]);
    expect(checkpointsFor([])).toEqual([]);
  });

  it("every anchored checkpoint must stay a prefix: appends and merges pass, a dropped count or a rewrite fails", () => {
    const s = store([{}, { w: W1 }, { w: W2 }, { w: W1 }]);
    const anchored = checkpointsFor(s);
    expect(anchorViolations(s, anchored)).toEqual([]);
    const grown = store([{}, { w: W1 }, { w: W2 }, { w: W1 }, { w: W1 }, { w: W2 }]);
    expect(anchorViolations(grown, anchored)).toEqual([]); // appends are fine
    expect(anchorViolations([grown[2], grown[0], grown[1], grown[3], grown[4], grown[5]], anchored)).toEqual([]); // a merge order too
    expect(anchorViolations(without(s, 3), anchored).join()).toMatch(/writer aaaaaaaaaaaaaaaa has 1 line\(s\), 2 anchored/); // a deleted tail
    const rewritten = store([{}, { w: W1 }, { w: W2 }, { w: W1, prev: undefined }]).map((e, i) => (i === 3 ? { ...e, raw: `${e.raw} ` } : e));
    expect(anchorViolations(rewritten, anchored).join()).toMatch(/line 2 is not the anchored one/);
    expect(anchorViolations(without(s, 0), anchored).join()).toMatch(/legacy line\(s\) anchored on this machine are gone/);
  });

  it("the legacy checkpoint is order-independent (a merge with an older kit's 1.0 lines)", () => {
    const s = store([{}, {}, { w: W1 }]);
    const anchored = checkpointsFor(s);
    expect(anchorViolations([s[1], s[0], s[2]], anchored)).toEqual([]);
    const late = store([{}, {}, { w: W1 }, {}]);
    expect(anchorViolations(late, anchored)).toEqual([]); // an older kit's late 1.0 line is not a deletion
  });

  it("advancedCheckpoints: only the streams whose count moved past the latest anchored one", () => {
    const s = store([{}, { w: W1 }, { w: W2 }]);
    const anchored = checkpointsFor(s);
    expect(advancedCheckpoints(checkpointsFor(s), anchored)).toEqual([]);
    const grown = store([{}, { w: W1 }, { w: W2 }, { w: W1 }]);
    expect(advancedCheckpoints(checkpointsFor(grown), anchored)).toEqual([{ w: W1, n: 2, sha: lineDigest(grown[3].raw) }]);
    expect(advancedCheckpoints(checkpointsFor(s), [])).toEqual(checkpointsFor(s));
  });

  it("parseAnchors: the checkpoints after the last reset, the resets, and an unparsable line as an error", () => {
    const text = [JSON.stringify({ at: "t1", checkpoints: [{ w: W1, n: 1, sha: "a".repeat(64) }] }), JSON.stringify({ at: "t2", reset: { reason: "restored", previous: "x" } }), JSON.stringify({ at: "t3", checkpoints: [{ w: W1, n: 2, sha: "b".repeat(64) }] }), ""].join("\n");
    const a = parseAnchors(text);
    expect(a.errors).toEqual([]);
    expect(a.resets).toEqual([{ at: "t2", reason: "restored", previous: "x" }]);
    expect(a.checkpoints.map((c) => c.n)).toEqual([2]); // only the checkpoints after the last reset count
    expect(parseAnchors(`${text}{not json\n`).errors.join()).toMatch(/anchors line 4 is not valid JSON/);
    expect(parseAnchors('{"at":"t","checkpoints":[{"w":"x"}]}\n').errors.join()).toMatch(/anchors line 1: a checkpoint needs/);
  });
});
