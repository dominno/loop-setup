// Anchors — the driven adapter for a record store's machine-local trust anchors (phase C, goal C4):
// this machine's writer id, the checkpoints and the store lock, all under
// <home>/loop-setup/anchors/ (layout.mjs names the paths; trace/chain.mjs decides). Nothing here
// is in the workspace or on the state branch, so a write into the workspace cannot change them.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { advancedCheckpoints, anchorViolations, checkpointsFor, parseAnchors, walkChains, WRITER_RE } from "../trace/chain.mjs";
import { loadEntries } from "../trace/lib.mjs";
import { anchorKey, anchorPaths, stateIdOf } from "./layout.mjs";

/** A path with its directory resolved (the file itself may not exist yet). */
const realish = (p) => {
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return resolve(p);
  }
};

/** The store's anchor key: its workspace id when it is that workspace's own store (stateIdOf), else store-<hash of its path>. */
export function storeKey({ claudeHome, storePath, workspace = null, workspaceId = null }) {
  const id = workspace ? stateIdOf({ claudeHome, workspace, workspaceId }) : null;
  const ownStore = !!id && realish(storePath) === realish(join(workspace, "trace/records.jsonl"));
  return anchorKey({ workspaceId: id, ownStore, pathDigest: createHash("sha256").update(realish(storePath)).digest("hex") });
}

/** This machine's writer id for a store (16 hex): read, or created once with O_EXCL. A corrupt file is never overwritten. */
export function writerId(claudeHome, key, { create = false } = {}) {
  const { writer } = anchorPaths(claudeHome, key);
  const read = () => {
    try {
      return readFileSync(writer, "utf8").trim();
    } catch {
      return null;
    }
  };
  let w = read();
  if (w === null && create) {
    mkdirSync(dirname(writer), { recursive: true });
    try {
      const fd = openSync(writer, "wx");
      writeSync(fd, `${randomBytes(8).toString("hex")}\n`);
      closeSync(fd);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    w = read();
  }
  if (w !== null && !WRITER_RE.test(w)) throw new Error(`${writer} does not hold a writer id — remove it to start a new writer`);
  return w;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
/** A lock left by a process that is gone on this host (or unreadable and over a minute old). */
function stale(lock) {
  try {
    const { pid, host } = JSON.parse(readFileSync(lock, "utf8"));
    return host === hostname() && Number.isInteger(pid) && !alive(pid);
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs > 60000;
    } catch {
      return false;
    }
  }
}

/**
 * Run fn holding the store's lock (O_EXCL): load → chain → append → anchor in every writer, rotate
 * and sync. A stale lock is taken over by an atomic rename; a live one is waited for, then refused.
 * opts.wait: ms to wait (default 10 s); opts.onBusy: called instead of throwing when the wait ends.
 */
export function withStoreLock(claudeHome, key, fn, { wait = 10000, onBusy = null } = {}) {
  const { lock } = anchorPaths(claudeHome, key);
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (stale(lock)) {
        const aside = `${lock}.stale-${randomBytes(4).toString("hex")}`;
        try {
          renameSync(lock, aside); // only one taker wins the rename
          rmSync(aside, { force: true });
        } catch {
          // another process took it over first
        }
        continue;
      }
      if (Date.now() > deadline) {
        if (onBusy) return onBusy();
        throw new Error(`the record store is locked by another loop-setup process (${lock}) — retry; remove the lock only if no loop-setup process is running`);
      }
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** This machine's anchors for a store: { exists, checkpoints, resets, errors }. */
export function readAnchors(claudeHome, key) {
  const { anchors } = anchorPaths(claudeHome, key);
  let text;
  try {
    text = readFileSync(anchors, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false, checkpoints: [], resets: [], errors: [] };
    throw e;
  }
  return { exists: true, ...parseAnchors(text) };
}

/**
 * The store against this machine's anchors (call with the store's entries). The chain errors are
 * replay's; this adds what needs the machine-local files. → { errors, warnings, anchored, resets }
 */
export function anchorReport({ claudeHome, key, entries }) {
  const { anchors, writer } = anchorPaths(claudeHome, key);
  const errors = [];
  const warnings = [];
  const a = readAnchors(claudeHome, key);
  errors.push(...a.errors.map((e) => `${anchors}: ${e}`));
  const chained = walkChains(entries).digests.size > 0;
  if (!a.exists && existsSync(writer)) errors.push(`the anchors file ${anchors} is missing, though this machine has a writer id for the store (${writer}) — the anchors were deleted`);
  else if (!a.exists && chained) warnings.push(`no anchors on this machine for this chained store (${anchors}) — tamper evidence holds only where the anchors were kept; the next SessionStart anchors it`);
  errors.push(...anchorViolations(entries, a.checkpoints));
  return { errors, warnings, anchored: a.checkpoints.length, resets: a.resets };
}

/** Append the checkpoints that advanced (all streams, or only writer `only`) — under the caller's lock. → true when a line was appended. */
export function anchorAdvanced({ claudeHome, key, entries, only = null, now = new Date().toISOString() }) {
  const a = readAnchors(claudeHome, key);
  if (a.errors.length) return false;
  const cps = advancedCheckpoints(checkpointsFor(entries), a.checkpoints).filter((c) => only === null || c.w === only);
  if (!cps.length) return false;
  const { anchors } = anchorPaths(claudeHome, key);
  mkdirSync(dirname(anchors), { recursive: true });
  appendFileSync(anchors, `${JSON.stringify({ at: now, checkpoints: cps })}\n`);
  return true;
}

/** A human's acknowledgement of a real count drop: the anchors file moves aside and a new one records why. */
export function resetAnchors({ claudeHome, key, reason, now = new Date().toISOString() }) {
  const { anchors } = anchorPaths(claudeHome, key);
  const previous = existsSync(anchors) ? `${basename(anchors)}.reset-${now.replace(/[:.]/g, "-")}` : null;
  if (previous) renameSync(anchors, join(dirname(anchors), previous));
  mkdirSync(dirname(anchors), { recursive: true });
  writeFileSync(anchors, `${JSON.stringify({ at: now, reset: { reason, previous } })}\n`);
  return { anchors, previous };
}

/**
 * A workspace store's integrity on this machine (SessionStart, doctor): its chains and its anchors.
 * With anchor: true and nothing wrong, the streams that advanced are anchored (under the lock; a busy
 * lock skips anchoring, never the check). → { errors, warnings, anchored, resets, appended }
 */
export function storeIntegrity({ claudeHome, workspace, workspaceId = null, anchor = false }) {
  const storePath = join(workspace, "trace/records.jsonl");
  const key = storeKey({ claudeHome, storePath, workspace, workspaceId });
  const entries = loadEntries(storePath);
  const chains = walkChains(entries);
  const report = anchorReport({ claudeHome, key, entries });
  const errors = [...chains.errors, ...report.errors];
  let appended = false;
  if (anchor && !errors.length) appended = withStoreLock(claudeHome, key, () => anchorAdvanced({ claudeHome, key, entries: loadEntries(storePath) }), { wait: 2000, onBusy: () => false });
  return { errors, warnings: [...chains.warnings, ...report.warnings], anchored: report.anchored, resets: report.resets, appended, key };
}
