// Performance gate — the objective half of the quality bar.
// Sums the gzipped size of the client JS chunks Next emits and fails if it exceeds
// the budget. The budget lives in ONE place: `qualityBar.perfBudgetKbGzip` in package.json
// (single source of truth; package.json is project contract, so CI needs no loop workspace).
// The quality-bar wiki page explains the target; it does not hold the number. Run after `next build`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { basename, join } from "node:path";

const BAR = "package.json";
const CHUNKS = ".next/static/chunks";
const MANIFEST = ".next/build-manifest.json";

const budgetKB = Number(JSON.parse(readFileSync(BAR, "utf8")).qualityBar?.perfBudgetKbGzip);
if (!(budgetKB > 0)) {
  console.error(`check-bundle-size: no positive qualityBar.perfBudgetKbGzip in ${BAR}`);
  process.exit(2);
}

if (!existsSync(CHUNKS)) {
  console.error(`check-bundle-size: ${CHUNKS} not found — run \`next build\` first.`);
  process.exit(2);
}

// Exclude the legacy noModule polyfill chunk(s): modern (module-supporting) browsers
// never download them, so counting them would overstate real first-load JS.
const polyfills = new Set();
if (existsSync(MANIFEST)) {
  for (const f of JSON.parse(readFileSync(MANIFEST, "utf8")).polyfillFiles || []) {
    polyfills.add(basename(f));
  }
} else {
  console.warn(
    `check-bundle-size: ${MANIFEST} not found — cannot exclude polyfill chunks, so the ` +
      `reported total may be inflated (a Next.js manifest move could cause this).`,
  );
}

let totalGz = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".js") && !polyfills.has(entry.name)) {
      totalGz += gzipSync(readFileSync(p)).length;
    }
  }
};
walk(CHUNKS);

const kb = totalGz / 1024;
const ok = kb <= budgetKB;
console.log(
  `first-load client JS: ${kb.toFixed(1)} KB gzip (budget ${budgetKB} KB) — ${ok ? "OK" : "OVER BUDGET"}`,
);
if (!ok) {
  console.error(
    `check-bundle-size: over budget by ${(kb - budgetKB).toFixed(1)} KB. ` +
      `Reduce the bundle, or consciously raise qualityBar.perfBudgetKbGzip in ${BAR} with a reason.`,
  );
  process.exit(1);
}
