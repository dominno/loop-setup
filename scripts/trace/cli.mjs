#!/usr/bin/env node
// TRACE-lite CLI — the only sanctioned writer of .claude/memory/trace/records.jsonl.
// Usage: pnpm trace <command> [...]   (see `pnpm trace help`)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendActions,
  BENCH_DIR,
  benchArgs,
  benchRecordDraft,
  DEFAULT_STORE,
  latestByClaim,
  loadEntries,
  TREE_ID_EXCLUDES,
  treeFingerprint,
  loadSchema,
  manifestViolations,
  readPolicyVersion,
  reauditCandidates,
  replay,
  ROOT,
  rotateStore,
  scoreBench,
  storeMetrics,
  writeRecords,
} from "./lib.mjs";

const HELP = `TRACE-lite — typed, append-only records for adjudicated claims (policy: .claude/memory/topics/trace.md)

  pnpm trace write <file|->            validate + append record drafts (object, array, or a workflow result with traceRecords:[...]) — all-or-nothing
  pnpm trace act <record_id> <consumer> <ACTION> [--ref X] [--note Y]
  pnpm trace act --from <file|->       append consumer actions ([{record_id, consumer, action, ref?, note?}], {actions:[...]}, or a critic-panel result's reuseActions)
  pnpm trace tree-id                   fingerprint of HEAD + uncommitted changes (verdict reuse / provenance.tree)
  pnpm trace show <record_id>          a record, its consumer actions, and its revision chain
  pnpm trace query [--claim-id ID] [--status S] [--writer PREFIX] [--subject S] [--latest] [--json]
  pnpm trace lint                      replay the whole store and check every contract invariant (exit 1 on error)
  pnpm trace reaudit [--act]           licensing records whose file evidence changed since their commit
  pnpm trace metrics                   store-level consumer-value metrics
  pnpm trace rotate [--max 500] [--keep 200]   lossless move of old lines into <YYYY>.jsonl archives
  pnpm trace bench-args [--arms verifier,single-pass,panel] [--repeat N] [--critics a,b] [--only B01-x,G01-y]
                                       print the args JSON for .claude/workflows/trace-bench.js (no ground truth)
  pnpm trace bench-score <results.json> [--record]   score a trace-bench run; --record also writes the measured-claim record
  pnpm trace bench-judge [--only ids] [--skip-e2e]   verify each fixture's judge.catches by running its deterministic check

  --store <path>  use another store (default .claude/memory/trace/records.jsonl; env TRACE_STORE)
  Actions: CLEAR HOLD COMMIT COMMIT_QUALIFIED QUARANTINE REJECT REUSE REAUDIT`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

function readJsonInput(src) {
  const text = !src || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  return JSON.parse(text);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function changedSince(commit, path) {
  // Compare the record's commit to the working tree; an unknown commit counts as
  // changed (fail closed: re-audit rather than trust stale evidence).
  try {
    execFileSync("git", ["diff", "--quiet", commit, "--", path], { cwd: ROOT, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function out(obj, asJson) {
  if (asJson) process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  else process.stdout.write((typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + "\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const storePath = flags.store || process.env.TRACE_STORE || DEFAULT_STORE;
  const now = new Date().toISOString();

  if (!cmd || cmd === "help" || cmd === "--help") return out(HELP);

  if (cmd === "tree-id") {
    const head = git(["rev-parse", "HEAD"]);
    if (!head) throw new Error("not a git checkout — cannot fingerprint the tree");
    const pathspec = [".", ...TREE_ID_EXCLUDES.map((p) => `:(exclude)${p}`)];
    const diff = execFileSync("git", ["diff", "HEAD", "--binary", "--", ...pathspec], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
    const untrackedPaths = (git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]) || "").split("\0").filter(Boolean);
    const untracked = untrackedPaths.map((p) => ({ path: p, content: readFileSync(join(ROOT, p)) }));
    process.stdout.write(treeFingerprint({ head, diff, untracked }) + "\n");
    return 0;
  }

  const schema = loadSchema();
  const policyVersion = readPolicyVersion();

  if (cmd === "write") {
    const input = readJsonInput(pos[0]);
    const drafts = Array.isArray(input)
      ? input
      : Array.isArray(input?.traceRecords)
        ? input.traceRecords
        : Array.isArray(input?.records)
          ? input.records
          : [input];
    // No fallback: provenance.commit is required, so a failed git lookup fails the write closed
    // (unless the draft carries its own commit).
    const commit = git(["rev-parse", "--short=12", "HEAD"]) || undefined;
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
    const results = writeRecords(drafts, { storePath, now, policyVersion, commit, branch, schema });
    out(results, true);
    return results.every((r) => r.stored) ? 0 : 1;
  }

  if (cmd === "act") {
    let drafts;
    if (flags.from) {
      const input = readJsonInput(flags.from === true ? "-" : flags.from);
      drafts = Array.isArray(input) ? input : input?.actions || input?.reuseActions || [];
    } else {
      const [record_id, consumer, action] = pos;
      if (!record_id || !consumer || !action) {
        out("usage: pnpm trace act <record_id> <consumer> <ACTION> [--ref X] [--note Y]");
        return 2;
      }
      drafts = [{ record_id, consumer, action: String(action).toUpperCase(), ref: flags.ref, note: flags.note }];
    }
    const results = appendActions(drafts, { storePath, now, policyVersion, schema });
    out(results, true);
    return results.every((r) => r.stored) ? 0 : 1;
  }

  const state = replay(loadEntries(storePath), schema, policyVersion);

  if (cmd === "lint") {
    const m = storeMetrics(state);
    for (const w of state.warnings) process.stderr.write(`warn: ${w}\n`);
    for (const e of state.errors) process.stderr.write(`error: ${e}\n`);
    out({ ok: state.errors.length === 0, errors: state.errors.length, warnings: state.warnings.length, records: m.records, store: storePath });
    return state.errors.length ? 1 : 0;
  }

  if (cmd === "show") {
    const id = pos[0];
    const rec = state.records.get(id);
    if (!rec) {
      out(`unknown record ${id}`);
      return 1;
    }
    const chain = [];
    let cur = rec;
    while (cur && cur.revises) {
      chain.push(cur.revises);
      cur = state.records.get(cur.revises);
    }
    const revisedBy = [...state.records.values()].filter((r) => r.revises === id).map((r) => r.record_id);
    out({ record: rec, actions: state.actions.get(id) || [], revises_chain: chain, revised_by: revisedBy, superseded: state.superseded.has(id) }, true);
    return 0;
  }

  if (cmd === "query") {
    let recs = flags.latest ? [...latestByClaim(state.records, state.superseded).values()] : [...state.records.values()];
    if (flags["claim-id"]) recs = recs.filter((r) => r.claim_id === flags["claim-id"]);
    if (flags.status) recs = recs.filter((r) => r.final_status === flags.status);
    if (flags.writer) recs = recs.filter((r) => r.writer_id.startsWith(flags.writer));
    if (flags.subject) recs = recs.filter((r) => r.subject === flags.subject);
    if (flags.json) return out(recs, true), 0;
    if (!recs.length) return out("(no matching records)"), 0;
    for (const r of recs) {
      const acts = (state.actions.get(r.record_id) || []).map((a) => a.action).join(",");
      out(`${r.record_id}  ${r.final_status.padEnd(7)} ${r.claim_type.padEnd(10)} ${r.claim_id}  ${acts ? `[${acts}]` : ""}\n    ${r.claim_text}${r.missing.length ? `\n    missing: ${r.missing.join("; ")}` : ""}`);
    }
    return 0;
  }

  if (cmd === "reaudit") {
    const cands = reauditCandidates(state.records, state.superseded, changedSince);
    if (flags.act && cands.length) {
      const res = appendActions(
        cands.map((c) => ({ record_id: c.record_id, consumer: "dream", action: "REAUDIT", note: `evidence changed: ${c.changed.join(", ")}` })),
        { storePath, now, policyVersion, schema },
      );
      out(res, true);
    }
    out(cands, true);
    return 0;
  }

  if (cmd === "metrics") return out(storeMetrics(state), true), 0;

  if (cmd === "rotate") {
    const res = rotateStore(storePath, { max: Number(flags.max || 500), keep: Number(flags.keep || 200) });
    out(res, true);
    return 0;
  }

  if (cmd === "bench-args" || cmd === "bench-score" || cmd === "bench-judge") {
    const manifest = JSON.parse(readFileSync(join(BENCH_DIR, "fixtures.json"), "utf8"));
    const problems = manifestViolations(manifest);
    if (problems.length) {
      out({ error: "invalid bench manifest", problems }, true);
      return 1;
    }
    const list = (x) => (typeof x === "string" ? x.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    if (cmd === "bench-args") {
      const args = benchArgs(manifest, {
        readPatch: (p) => readFileSync(join(BENCH_DIR, p), "utf8"),
        arms: list(flags.arms),
        repeat: flags.repeat ? Number(flags.repeat) : undefined,
        critics: list(flags.critics),
        only: list(flags.only),
      });
      process.stdout.write(JSON.stringify(args) + "\n");
      return 0;
    }
    if (cmd === "bench-judge") {
      const { runBenchJudge } = await import("./bench-judge.mjs");
      const results = runBenchJudge(manifest, { only: list(flags.only), skipE2e: !!flags["skip-e2e"] });
      out(results, true);
      return results.every((r) => r.ok !== false) ? 0 : 1;
    }
    const resultsRef = pos[0] || "-";
    const raw = readJsonInput(resultsRef);
    const score = scoreBench(manifest, raw && raw.runs ? raw : raw?.result || raw);
    out(score, true);
    if (flags.record) {
      const prior = latestByClaim(state.records, state.superseded).get("bench:trace-bench-lite");
      const commit = git(["rev-parse", "--short=12", "HEAD"]) || undefined;
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
      const res = writeRecords([benchRecordDraft(score, { resultsRef, priorRecordId: prior && prior.record_id })], { storePath, now, policyVersion, commit, branch, schema });
      out(res, true);
      return res.every((r) => r.stored) ? 0 : 1;
    }
    return 0;
  }

  out(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (e) => {
    process.stderr.write(`trace: ${e.message || e}\n`);
    process.exitCode = 1;
  },
);
