#!/usr/bin/env node
// TRACE-lite CLI — the only sanctioned writer of .claude/memory/trace/records.jsonl.
// Usage: pnpm trace <command> [...]   (see `pnpm trace help`)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  appendActions,
  BENCH_BUNDLE,
  benchArgs,
  benchRecordDraft,
  briefRecords,
  contaminatedRuns,
  encodeBench,
  leakMarkers,
  loadWorkflowBlock,
  markContaminated,
  markUnscanned,
  insideRepo,
  numstatPaths,
  CODE_PATHS,
  readBench,
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

  pnpm trace write <file|-> [--then-act ACTION --consumer NAME [--note N]]
                                       validate + append record drafts (object, array, or a workflow result with
                                       traceRecords:[...]); --then-act then appends ACTION on every stored record
                                       (records are stored first — if the action batch is refused, act again) — all-or-nothing
  pnpm trace act <record_id> <consumer> <ACTION> [--ref X] [--note Y]
  pnpm trace act --from <file|->       append consumer actions ([{record_id, consumer, action, ref?, note?}], {actions:[...]}, or a critic-panel result's reuseActions)
  pnpm trace tree-id                   fingerprint of HEAD + uncommitted changes (verdict reuse / provenance.tree)
  pnpm trace show <record_id>          a record, its consumer actions, and its revision chain
  pnpm trace query [--claim-id ID] [--status S] [--writer PREFIX] [--subject S] [--latest] [--json] [--brief]
                                       --brief: compact JSON (newest 40, only the fields critic-panel reads) for args.priorRecords
  pnpm trace denylist-check --patch <file>
                                       BEFORE applying a patch: run the loop's production denylist (read from HEAD) over
                                       every path git's own parser finds in it (git apply --numstat) — exit 1 on a hit,
                                       exit 2 when it cannot be verified (git error, no paths)
  pnpm trace lint                      replay the whole store and check every contract invariant (exit 1 on error)
  pnpm trace reaudit [--act]           licensing records whose file evidence changed since their commit
  pnpm trace metrics                   store-level consumer-value metrics
  pnpm trace rotate [--max 500] [--keep 200]   lossless move of old lines into <YYYY>.jsonl archives
  pnpm trace bench-args [--arms verifier,single-pass,panel] [--repeat N] [--critics a,b] [--only B01-x,G01-y]
                                       print the args JSON for .claude/workflows/trace-bench.js (no ground truth)
  pnpm trace bench-score <results.json>... --transcripts <dir> [--record]
                                       score trace-bench run(s) (runs concatenated); agent transcripts are scanned for
                                       leaked ground truth (contaminated runs excluded, F0); --record writes the record
  pnpm trace bench-unpack <dir>        decode the fixture bundle into <dir> (outside the repo!) for editing
  pnpm trace bench-pack <dir>          re-encode <dir>/fixtures.json (patches inline) into the bundle
  pnpm trace bench-judge [--only ids] [--skip-e2e] [--recover]   verify each fixture's judge.catches by running its
                                       deterministic check; --recover reverses fixture patches left applied by a killed run

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

/** Concatenated product sources (see CODE_PATHS / patchOnlyTokens). */
function codeText() {
  const files = (git(["ls-files", "-z", "--", ...CODE_PATHS]) || "").split("\0").filter(Boolean);
  return files
    .map((p) => {
      try {
        return readFileSync(join(ROOT, p), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
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
    // Unreadable entries (a nested checkout listed as a directory, a broken symlink) are
    // fingerprinted by path only rather than crashing the command.
    const untracked = untrackedPaths.map((p) => {
      try {
        return { path: p, content: readFileSync(join(ROOT, p)) };
      } catch {
        return { path: p, content: "<unreadable>" };
      }
    });
    process.stdout.write(treeFingerprint({ head, diff, untracked }) + "\n");
    return 0;
  }

  const schema = loadSchema();
  const policyVersion = readPolicyVersion();

  const benchForbidden = () => {
    try {
      return leakMarkers(readBench(), codeText());
    } catch {
      return []; // no bundle → nothing to guard
    }
  };

  if (cmd === "denylist-check") {
    // Judge the PATCH, before it is applied — not the working tree (which also holds the
    // Lead's own bookkeeping and unrelated uncommitted edits, and which a patch could
    // rewrite to weaken the very check that inspects it). Paths come from git's own
    // parser, the denylist from HEAD; anything that cannot be verified exits 2 (fail closed).
    if (typeof flags.patch !== "string") {
      out("usage: pnpm trace denylist-check --patch <file>   (run it BEFORE git apply <file>)");
      return 2;
    }
    const sh = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
    let paths;
    let hitsDenylist;
    try {
      // `git apply --numstat` names only the DESTINATION of a rename/copy; the reversed
      // patch names its source — the union covers both sides (renaming a protected file
      // away deletes it).
      const patch = resolve(flags.patch);
      paths = [...new Set([...numstatPaths(sh(["apply", "--numstat", "-z", patch])), ...numstatPaths(sh(["apply", "--numstat", "-z", "-R", patch]))])];
      ({ hitsDenylist } = loadWorkflowBlock("loop-iteration.js", "loop-denylist", ["hitsDenylist"], { source: sh(["show", "HEAD:.claude/workflows/loop-iteration.js"]) }));
    } catch (e) {
      out({ ok: false, error: `could not verify the patch: ${String(e.stderr || e.message || e).trim().split("\n")[0]}` }, true);
      return 2;
    }
    if (!paths.length) {
      out({ ok: false, error: "git found no paths in the patch — nothing can be verified" }, true);
      return 2;
    }
    const hits = paths.filter((p) => hitsDenylist([p]));
    out({ ok: hits.length === 0, checked: paths.length, paths, hits }, true);
    return hits.length ? 1 : 0;
  }

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
    // Leak guard: the store is in the tree bench agents grep, so a draft naming a bench
    // fixture or its defect is refused (fail closed) — redact it and write again.
    const forbidden = benchForbidden();
    const results = writeRecords(drafts, { storePath, now, policyVersion, commit, branch, schema, forbidden });
    out(results, true);
    if (!results.every((r) => r.stored)) return 1;
    if (flags["then-act"]) {
      if (!flags.consumer) {
        out("--then-act needs --consumer <name>");
        return 2;
      }
      const acts = appendActions(
        results.map((r) => ({ record_id: r.record_id, consumer: flags.consumer, action: String(flags["then-act"]).toUpperCase(), note: flags.note })),
        { storePath, now: new Date().toISOString(), policyVersion, schema, forbidden },
      );
      out(acts, true);
      return acts.every((a) => a.stored) ? 0 : 1;
    }
    return 0;
  }

  if (cmd === "act") {
    let drafts;
    if (flags.from) {
      const input = readJsonInput(flags.from === true ? "-" : flags.from);
      drafts = Array.isArray(input) ? input : Array.isArray(input?.actions) ? input.actions : Array.isArray(input?.reuseActions) ? input.reuseActions : null;
      if (drafts === null) {
        out("no actions found in the input (expected an array, {actions:[...]} or a result with reuseActions)");
        return 1;
      }
      // A recognised but empty list (a critic round that reused nothing) is a normal outcome.
      if (!drafts.length) {
        out("nothing to record (0 actions)");
        return 0;
      }
    } else {
      const [record_id, consumer, action] = pos;
      if (!record_id || !consumer || !action) {
        out("usage: pnpm trace act <record_id> <consumer> <ACTION> [--ref X] [--note Y]");
        return 2;
      }
      drafts = [{ record_id, consumer, action: String(action).toUpperCase(), ref: flags.ref, note: flags.note }];
    }
    const results = appendActions(drafts, { storePath, now, policyVersion, schema, forbidden: benchForbidden() });
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
    if (flags.brief) {
      process.stdout.write(JSON.stringify(briefRecords(recs)) + "\n");
      return 0;
    }
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
        { storePath, now, policyVersion, schema, forbidden: benchForbidden() },
      );
      out(res, true);
      if (!res.every((r) => r.stored)) return 1;
    }
    out(cands, true);
    return 0;
  }

  if (cmd === "metrics") {
    const m = storeMetrics(state);
    for (const f of m.flags) process.stderr.write(`flag: ${f}\n`);
    return out(m, true), 0;
  }

  if (cmd === "rotate") {
    const res = rotateStore(storePath, { max: Number(flags.max || 500), keep: Number(flags.keep || 200) });
    out(res, true);
    return 0;
  }

  if (cmd === "bench-pack") {
    const dir = pos[0];
    if (!dir) return out("usage: pnpm trace bench-pack <dir containing fixtures.json>"), 2;
    const manifest = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
    const problems = manifestViolations(manifest);
    if (problems.length) return out({ error: "invalid bench manifest", problems }, true), 1;
    writeFileSync(BENCH_BUNDLE, encodeBench(manifest));
    out(`packed ${manifest.fixtures.length} fixtures into ${BENCH_BUNDLE}`);
    return 0;
  }

  if (cmd === "bench-unpack") {
    const dir = pos[0];
    if (!dir) return out("usage: pnpm trace bench-unpack <dir outside the repo>"), 2;
    if (insideRepo(dir)) {
      out("refusing to unpack inside the repo — plain-text fixtures there would contaminate the next bench run");
      return 1;
    }
    writeFileSync(join(dir, "fixtures.json"), JSON.stringify(readBench(), null, 2) + "\n");
    out(`unpacked to ${join(dir, "fixtures.json")} (patches are inline)`);
    return 0;
  }

  if (cmd === "bench-args" || cmd === "bench-score" || cmd === "bench-judge") {
    const manifest = readBench();
    const problems = manifestViolations(manifest);
    if (problems.length) {
      out({ error: "invalid bench manifest", problems }, true);
      return 1;
    }
    const list = (x) => (typeof x === "string" ? x.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    if (cmd === "bench-args" || cmd === "bench-judge") {
      // Precondition (kept out of `pnpm test` so product edits never redden the main gate):
      // no fixture patch may still be applied (a killed run — --recover reverses it, and is
      // checked FIRST, since an applied patch also fails the stale check), and every fixture
      // must still apply, else the bench would measure a broken setup.
      const { benchPreflight } = await import("./bench-judge.mjs");
      const pre = benchPreflight(manifest, { recover: cmd === "bench-judge" && !!flags.recover });
      if (pre.reversed) {
        out({ reversed: pre.reversed }, true);
        return 0;
      }
      if (pre.error) {
        out(pre, true);
        return 1;
      }
    }
    if (cmd === "bench-args") {
      const args = benchArgs(manifest, {
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
      const results = await runBenchJudge(manifest, { only: list(flags.only), skipE2e: !!flags["skip-e2e"] });
      out(results, true);
      return results.every((r) => r.ok !== false) ? 0 : 1;
    }
    const refs = pos.length ? pos : ["-"];
    const resultsRef = refs.join(" ");
    let runs = refs.flatMap((ref) => {
      const raw = readJsonInput(ref);
      const res = raw && raw.runs ? raw : raw?.result || raw;
      return Array.isArray(res?.runs) ? res.runs : [];
    });
    // Contamination scan (F0): any agent whose transcript contains a real fixture id or
    // defect text saw ground truth; its runs are excluded. Required for --record.
    const tdirs = flags.transcripts ? String(flags.transcripts).split(",") : [];
    if (!tdirs.length && flags.record) {
      out("--record needs --transcripts <workflow transcript dir> — an unscanned run cannot be recorded as a measurement");
      return 1;
    }
    const transcripts = tdirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => /^agent-.*\.jsonl$/.test(f))
        .map((f) => {
          let label = "";
          try {
            label = JSON.parse(readFileSync(join(d, f.replace(/\.jsonl$/, ".meta.json")), "utf8")).description || "";
          } catch {
            /* no meta → unknown label */
          }
          return { label, text: readFileSync(join(d, f), "utf8") };
        }),
    );
    if (flags.record && transcripts.length === 0) {
      out("--record: the transcript dir holds no agent transcripts — an unscanned run cannot be recorded (fail closed)");
      return 1;
    }
    const keys = contaminatedRuns(transcripts, manifest);
    runs = markUnscanned(markContaminated(runs, keys), transcripts);
    const score = scoreBench(manifest, { runs, unattributedLeaks: keys.filter((k) => k.arm === "unknown").length });
    score.transcriptsScanned = transcripts.length;
    if (flags.record && score.unattributedLeaks) {
      out(score, true);
      out("--record refused: ground truth leaked into a transcript that cannot be tied to a run (F0)");
      return 1;
    }
    if (flags.record && score.unscannedRuns) {
      out(score, true);
      out(`--record refused: ${score.unscannedRuns} run(s) have no scanned transcript — is --transcripts this run's transcript dir? (F0)`);
      return 1;
    }
    out(score, true);
    if (flags.record) {
      const prior = latestByClaim(state.records, state.superseded).get("bench:trace-bench-lite");
      const commit = git(["rev-parse", "--short=12", "HEAD"]) || undefined;
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
      const res = writeRecords([benchRecordDraft(score, { resultsRef, priorRecordId: prior && prior.record_id })], { storePath, now, policyVersion, commit, branch, schema, forbidden: benchForbidden() });
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
