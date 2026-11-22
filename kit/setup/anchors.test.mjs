// The anchors adapter's store lock on the real file system: an O_EXCL lock file holding
// { pid, host, at, nonce }, a stale lock (a process gone on this host) taken over, a live one
// waited for and refused, and a lock released only by its holder.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { anchorPaths } from "./layout.mjs";
import { withStoreLock } from "./anchors.mjs";

let home;
const KEY = "app-1a2b3c4d";
const lockPath = () => anchorPaths(home, KEY).lock;
const plant = (content) => {
  mkdirSync(join(home, "loop-setup/anchors"), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify(content));
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anchors-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("withStoreLock", () => {
  it("holds the lock while fn runs and removes it afterwards", () => {
    const seen = withStoreLock(home, KEY, () => JSON.parse(readFileSync(lockPath(), "utf8")));
    expect(seen).toMatchObject({ pid: process.pid, host: hostname() });
    expect(seen.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("takes over a stale lock (its process is gone on this host)", () => {
    plant({ pid: 2 ** 22 + 12345, host: hostname(), at: "2026-01-01T00:00:00.000Z", nonce: "0".repeat(16) });
    expect(withStoreLock(home, KEY, () => "ran", { wait: 200 })).toBe("ran");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("waits for a live lock and then refuses (or calls onBusy)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    try {
      plant({ pid: child.pid, host: hostname(), at: new Date().toISOString(), nonce: "1".repeat(16) });
      expect(() => withStoreLock(home, KEY, () => "ran", { wait: 150 })).toThrow(/locked by another loop-setup process/);
      expect(withStoreLock(home, KEY, () => "ran", { wait: 150, onBusy: () => "busy" })).toBe("busy");
      expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(child.pid); // never taken from a live holder
    } finally {
      child.kill();
    }
  });

  it("releases only its own lock: a lock replaced under it (a takeover race) is left to its holder", () => {
    withStoreLock(home, KEY, () => {
      writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, host: hostname(), at: "x", nonce: "f".repeat(16) }));
    });
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).nonce).toBe("f".repeat(16));
  });
});
