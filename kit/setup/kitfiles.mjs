// The installed kit's file manifest: the installer records the sha256 of every kit file in
// <loop home>/installed.json, so a trust anchor read from an installed kit (outside any git
// repository) is verified against what was installed, never taken as-is.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./kittree.mjs";

export { sha256 };

/** <loop home>/installed.json for a kit installed at <loop home>/kit. */
export const manifestPathFor = (kitRoot) => join(dirname(kitRoot), "installed.json");

/**
 * The text of an installed kit file, after checking its sha256 against the install manifest.
 * Throws (callers fail closed) when there is no manifest, the file is not in it, or it changed.
 */
export function verifiedKitFile(kitRoot, rel) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPathFor(kitRoot), "utf8"));
  } catch {
    throw new Error(`no install manifest next to ${kitRoot} — reinstall the kit (loop-setup install)`);
  }
  const want = manifest?.files?.[rel];
  if (!want) throw new Error(`${rel} is not in the install manifest — reinstall the kit`);
  const buf = readFileSync(join(kitRoot, rel));
  if (sha256(buf) !== want) throw new Error(`${rel} differs from the installed copy (sha256 mismatch) — the kit was modified after install; reinstall it`);
  return buf.toString("utf8");
}
