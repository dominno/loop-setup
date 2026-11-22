// The record chain — the PURE core of the tamper-evident store (phase C, goal C4, policy v4).
// Every line a writer appends (schema trace-lite/1.1) carries chain { w, prev }: w is the writer
// id, prev the digest of that writer's previous line in store order (null for its first). Lines
// without a chain (trace-lite/1.0) are the legacy part. A checkpoint pins a prefix of one stream:
// a writer's first n lines (by the digest of its n-th line) or the legacy lines (by their ids, a
// set, because merges with an older kit may reorder them). Anchors (machine-local checkpoints) are
// read and written by the adapter (kit/setup/anchors.mjs); this module only decides.
// Entries are the store model of lib.mjs: [{ source, line, raw, value }] in stream order.
import { createHash } from "node:crypto";

export const WRITER_RE = /^[0-9a-f]{16}$/;
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/** A line's digest: sha256 of the line exactly as stored, minus one trailing \r (a CRLF checkout keeps every chain). */
export const lineDigest = (raw) =>
  createHash("sha256")
    .update(String(raw).replace(/\r$/, ""))
    .digest("hex");

const idOf = (v) => (v.kind === "action" ? v.action_id : v.record_id);

/**
 * Walk the stream once. → { errors, warnings, digests: Map(w → [digest of line 1..n]), legacy: [ids] }
 *   error    a line whose prev is not the digest of its writer's previous line (an edit, a deletion,
 *            a reorder or a fork in that writer's history)
 *   warning  an unchained line after the first chained one: an older kit wrote it (or someone
 *            inserted it); it belongs to no chain
 */
export function walkChains(entries) {
  const errors = [];
  const warnings = [];
  const digests = new Map();
  const legacy = [];
  let chained = false;
  for (const e of entries) {
    const v = e && e.value;
    if (!v || typeof v !== "object") continue; // unparsable lines are replay's errors
    const at = `${e.source}:${e.line}`;
    const c = v.chain;
    if (!c || typeof c !== "object") {
      if (chained) warnings.push(`${at}: unchained line ${idOf(v)} after the first chained line — written by a kit older than policy v4 (or inserted); it belongs to no chain: upgrade every machine that shares this workspace`);
      legacy.push(idOf(v));
      continue;
    }
    chained = true;
    const ds = digests.get(c.w) || [];
    const expected = ds.length ? ds[ds.length - 1] : null;
    if ((c.prev ?? null) !== expected) {
      errors.push(`${at}: ${idOf(v)}: chain.prev does not match the previous line of writer ${c.w} (${ds.length ? `its line ${ds.length}` : "it has none"}) — a line of that writer was edited, deleted or reordered`);
    }
    ds.push(lineDigest(e.raw));
    digests.set(c.w, ds);
  }
  return { errors, warnings, digests, legacy };
}

export const chainViolations = (entries) => walkChains(entries).errors;

/** { w, prev } for the next line writer w appends: the digest of its last line in the stream, or null. */
export function nextChain(entries, w) {
  const ds = walkChains(entries).digests.get(w) || [];
  return { w, prev: ds.length ? ds[ds.length - 1] : null };
}

/**
 * Chain a batch: starting from `start` ({ w, prev }), set chain on each item, finalize it (the
 * caller computes the id, which hashes the chain), and thread prev through the finalized lines.
 * Only the lines that will actually be appended may be passed (after dedupe and screening).
 */
export function chainBatch(start, items, finalize) {
  let prev = start.prev;
  return items.map((it) => {
    const v = finalize({ ...it, chain: { w: start.w, prev } });
    prev = lineDigest(JSON.stringify(v));
    return v;
  });
}

/** One checkpoint per stream: the legacy lines as a sorted id set, then each writer's count and last digest. */
export function checkpointsFor(entries) {
  const { digests, legacy } = walkChains(entries);
  const out = [];
  if (legacy.length) out.push({ w: null, n: legacy.length, ids: [...legacy].sort() });
  for (const w of [...digests.keys()].sort()) {
    const ds = digests.get(w);
    out.push({ w, n: ds.length, sha: ds[ds.length - 1] });
  }
  return out;
}

/** Every anchored checkpoint must still be a prefix of its stream: the count never drops, the digest at n matches. */
export function anchorViolations(entries, anchored) {
  const { digests, legacy } = walkChains(entries);
  const legacySet = new Set(legacy);
  const out = new Set();
  for (const c of anchored) {
    if (c.w === null) {
      const gone = (c.ids || []).filter((id) => !legacySet.has(id));
      if (gone.length) out.add(`${gone.length} legacy line(s) anchored on this machine are gone (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", …" : ""})`);
      else if (legacy.length < c.n) out.add(`the legacy lines number ${legacy.length}, ${c.n} anchored — the count dropped`);
      continue;
    }
    const ds = digests.get(c.w) || [];
    if (ds.length < c.n) out.add(`writer ${c.w} has ${ds.length} line(s), ${c.n} anchored — the count dropped (a line was deleted)`);
    else if (ds[c.n - 1] !== c.sha) out.add(`writer ${c.w}'s line ${c.n} is not the anchored one — its history was rewritten`);
  }
  return [...out];
}

/** The checkpoints that moved past the latest anchored one of their stream (what is worth appending). */
export function advancedCheckpoints(current, anchored) {
  const latest = new Map();
  for (const c of anchored) latest.set(c.w, Math.max(latest.get(c.w) || 0, c.n));
  return current.filter((c) => c.n > (latest.get(c.w) || 0));
}

const validCheckpoint = (c) =>
  c && typeof c === "object" && Number.isInteger(c.n) && c.n > 0 && (c.w === null ? Array.isArray(c.ids) : WRITER_RE.test(String(c.w)) && DIGEST_RE.test(String(c.sha)));

/**
 * An anchors file's text. Each line is { at, checkpoints: [...] } or { at, reset: { reason, previous } }.
 * → { checkpoints (those after the last reset), resets: [{ at, reason, previous }], errors }
 */
export function parseAnchors(text) {
  const errors = [];
  const resets = [];
  let checkpoints = [];
  String(text || "")
    .split("\n")
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      let v;
      try {
        v = JSON.parse(raw);
      } catch {
        errors.push(`anchors line ${i + 1} is not valid JSON`);
        return;
      }
      if (v && v.reset && typeof v.reset === "object") {
        resets.push({ at: v.at, ...v.reset });
        checkpoints = [];
        return;
      }
      if (!v || !Array.isArray(v.checkpoints) || !v.checkpoints.every(validCheckpoint)) {
        errors.push(`anchors line ${i + 1}: a checkpoint needs { w: <16 hex>, n, sha } or { w: null, n, ids }`);
        return;
      }
      checkpoints.push(...v.checkpoints);
    });
  return { checkpoints, resets, errors };
}
