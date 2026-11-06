#!/usr/bin/env node
// TRACE-lite CLI — the only sanctioned writer of .claude/memory/trace/records.jsonl.
// Usage: pnpm trace <command> [...]   (see `pnpm trace help`)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
  unmatchedLeaks,
  insideRepo,
  numstatPaths,
  CODE_PATHS,
  readBench,
  DEFAULT_STORE,
  l3Check,
  latestByClaim,
  loadEntries,
  loadWiki,
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
  VERIFIER_FILE,
  verifierBlockHash,
  wikiViolations,
  writeRecords,
} from "./lib.mjs";
import { DEFAULT_PLAN, MAX_SCOPE, conflictFreeBatch, parsePlan, planDrift, planItems, planViolations, readyIds } from "./plan.mjs";
import { STORY_MAP, STORY_MAP_PATHS, parseStory, storyMapViolations } from "./story-map.mjs";

const HELP = `TRACE-lite — typed, append-only records for adjudicated claims (policy: .claude/memory/topics/trace.md)

  pnpm trace write <file|-> [--then-act ACTION --consumer NAME [--note N]]
                                       validate + append record drafts (object, array, or a workflow result with
                                       traceRecords:[...]); --then-act then appends ACTION on every stored record
                                       (records are stored first — if the action batch is refused, act again) — all-or-nothing
  pnpm trace act <record_id> <consumer> <ACTION> [--ref X] [--note Y]
  pnpm trace act --from <file|->       append consumer actions ([{record_id, consumer, action, ref?, note?}], {actions:[...]}, or a critic-panel result's reuseActions)
  pnpm trace tree-id                   fingerprint of HEAD + uncommitted changes (verdict reuse / provenance.tree)
  pnpm trace show <record_id>          a record, its consumer actions, and its revision chain
  pnpm trace query [--claim-id ID] [--status S] [--severity S] [--writer PREFIX] [--subject S] [--latest] [--json] [--brief]
                                       --severity: exact match on a record's severity (blocker|important|nice-to-have; a
                                       missing or other value exits 2), combinable with the other filters
                                       --brief: compact JSON (newest 40, only the fields critic-panel reads) for args.priorRecords
  pnpm trace denylist-check --patch <file>
                                       BEFORE applying a patch: run the loop's production denylist (read from HEAD) over
                                       every path git's own parser finds in it (git apply --numstat) — exit 1 on a hit,
                                       exit 2 when it cannot be verified (git error, no paths)
  pnpm trace lint                      replay the whole store and check every contract invariant (exit 1 on error)
  pnpm trace plan-ready [--max N | --batch N] [--json] [--plan p]
                                       the loop plan's ready node ids as a JSON array (loop-plan.md's ready-node rule),
                                       ranked by the origin record's severity (blocker, important, the rest), table order
                                       breaking ties; --max N keeps the first N; --batch N keeps a greedy set whose scopes do
                                       not overlap (an empty scope goes alone), then the first N, naming each skipped id on
                                       stderr; --json prints those rows in full — exit 1
                                       and no ids when the plan table does not parse, 2 when the store does not replay
  pnpm trace plan-lint [--pre-dispatch [--max-scope N]] [--plan p]
                                       check the plan against its contract and the record store (consistency, not truth):
                                       exit 1 on an error, 2 when the store does not replay; --pre-dispatch also fails on
                                       an in-progress node, a ready node with no check, and one whose scope lists more
                                       than N paths (default 3; L3 passes 1) — run it before every dispatch
  pnpm trace plan-drift [--base <ref> | --base-plan <file>] [--plan p]
                                       advisory, exit 0: done nodes whose CLEARed diff touched paths outside their scope,
                                       and the nodes added, removed or moved since the base plan (default: the plan at
                                       the last commit of the run log) — consistency, not truth; never evidence
  pnpm trace plan-items <ids…> [--plan p]
                                       loop-iteration args.items for ready nodes: [{id, description, priorRecordId?,
                                       missing?}]; priorRecordId only for the node's own loop:<id> record, never a
                                       critic one — exit 1 and no items when any id is not ready, 2 when the store
                                       does not replay
  pnpm trace story-lint [--root dir]   the story map (${STORY_MAP}/: story files, index, dashboard, verification log, E2E
                                       coverage map) against itself and the store (consistency, not truth): one status
                                       per story everywhere, plus the log row, coverage and licensing Record: line its
                                       level needs, and (warning) each story's open loop-plan nodes — exit 1 on an error;
                                       an absent story map passes
  pnpm trace wiki-check                the memory wiki (.claude/memory) against the store (consistency, not truth): rec:
                                       comments, committed facts, quarantine rows, page sizes — JSON {ok, errors,
                                       warnings}; exit 1 on an error, 2 when the store does not replay
  pnpm trace l3-check [--json]         the L3 measured-checker item of .claude/loop-checklist.md, computed: the latest
                                       bench:trace-bench-lite record is accept, from a verifier arm run at repeat ≥ 2
                                       over every manifest fixture in every repeat (no --only subset), with no F0, F3
                                       or F4 in its failed_gates, and names the current <loop-verifier> block by its
                                       sha256 — exit 0 when all hold, else exit 1 listing every unmet condition
  pnpm trace reaudit [--act]           licensing records whose file evidence changed since their commit; one whose
                                       commit the repo no longer has (squashed away) is listed apart, as unreachable
  pnpm trace metrics                   store-level consumer-value metrics
  pnpm trace rotate [--max 500] [--keep 200]   lossless move of old lines into <YYYY>.jsonl archives
  pnpm trace bench-args [--arms verifier,single-pass,panel] [--repeat N] [--critics a,b] [--only B01-x,G01-y]
                                       print the args JSON for .claude/workflows/trace-bench.js (no ground truth)
  pnpm trace bench-score <results.json>... --transcripts <dir> [--record]
                                       score trace-bench run(s) (runs concatenated); agent transcripts are scanned for
                                       leaked ground truth (contaminated runs excluded, F0); --record writes the record:
                                       the fixtures each arm measured next to the manifest's counts, and — for a run
                                       with a verifier arm — the <loop-verifier> block it measured by its sha256 (read
                                       when you score)
  pnpm trace bench-unpack <dir>        decode the fixture bundle into <dir> (outside the repo!) for editing
  pnpm trace bench-pack <dir>          re-encode <dir>/fixtures.json (patches inline) into the bundle
  pnpm trace bench-judge [--only ids] [--skip-e2e] [--recover]   verify each fixture's judge.catches by running its
                                       deterministic check; --recover reverses fixture patches left applied by a killed run

  --store <path>  use another store (default .claude/memory/trace/records.jsonl; env TRACE_STORE)
  --plan <path>   use another loop plan (default .claude/memory/loop-plan.md)
  --root <dir>    story-lint: read the story map of another checkout, e.g. a scratch copy (default: this repo)
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

// The sha256 of the production <loop-verifier> block as it is in the working tree (the bench
// Workflow runs trace-bench.js's byte-identical copy, parity-tested), or null when it cannot be
// read: bench-score records it, l3-check compares the latest bench record against it.
function currentVerifierHash() {
  try {
    return verifierBlockHash(readFileSync(join(ROOT, VERIFIER_FILE), "utf8"));
  } catch {
    return null; // no such file: nothing to name or compare
  }
}

function changedSince(commit, path) {
  // Compare the record's commit to the working tree; a diff that fails counts as
  // changed (fail closed: re-audit rather than trust stale evidence).
  try {
    execFileSync("git", ["diff", "--quiet", commit, "--", path], { cwd: ROOT, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

// Does the repository still have the commit? One squashed away and pruned (or absent from a shallow
// clone) cannot be diffed against: reaudit lists its record apart instead of as "evidence changed".
function reachable(commit) {
  return git(["cat-file", "-e", `${commit}^{commit}`]) !== null;
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

  // The loop plan's DAG (.claude/memory/loop-plan.md, or --plan p). Readiness is computed, never
  // hand-derived, and a table that does not parse fails closed: no ids, exit 1.
  const planPath = typeof flags.plan === "string" ? resolve(flags.plan) : DEFAULT_PLAN;
  const readPlan = () => {
    try {
      return parsePlan(readFileSync(planPath, "utf8"));
    } catch (e) {
      return { nodes: [], errors: [`[table] cannot read the plan ${planPath}: ${e.message}`] };
    }
  };
  // True (after reporting why) when the plan table does not parse: then no ids are printed at all.
  const unparsed = (plan) => {
    if (!plan.errors.length) return false;
    for (const e of plan.errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write(`${cmd}: the plan table does not parse — no ids (pnpm trace plan-lint lists every problem)\n`);
    return true;
  };

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
      const lists = Array.isArray(input) ? [input] : [input?.actions, input?.reuseActions].filter(Array.isArray);
      drafts = lists.length ? lists.flat() : null;
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

  if (cmd === "plan-ready") {
    const positive = (v) => (v !== undefined ? (/^[1-9]\d*$/.test(String(v)) ? Number(v) : NaN) : undefined);
    const max = positive(flags.max);
    const batchN = positive(flags.batch);
    if (flags.plan === true || Number.isNaN(max) || Number.isNaN(batchN) || (max !== undefined && batchN !== undefined)) {
      out("usage: pnpm trace plan-ready [--max N | --batch N] [--json] [--plan p]   (N a positive integer)");
      return 2;
    }
    // The ranking reads the origin records' severity, so a store that does not replay yields no ids.
    if (state.errors.length) {
      process.stderr.write(`error: the record store does not replay (${state.errors.length} error(s)) — no ids; run pnpm trace lint\n`);
      return 2;
    }
    const plan = readPlan();
    if (unparsed(plan)) return 1;
    let ids = readyIds(plan.nodes, { max, state });
    if (batchN !== undefined) {
      const { batch, skipped } = conflictFreeBatch(plan.nodes, ids, batchN);
      for (const k of skipped) process.stderr.write(`skip: ${k.id} conflicts with ${k.conflictsWith} (overlapping scope; it waits for a later call)\n`);
      ids = batch;
    }
    if (flags.json) {
      const byId = new Map(plan.nodes.map((n) => [n.id, n]));
      out(ids.map((id) => byId.get(id)), true);
    } else process.stdout.write(JSON.stringify(ids) + "\n");
    return 0;
  }

  if (cmd === "plan-lint") {
    if (flags.plan === true) {
      out("usage: pnpm trace plan-lint [--pre-dispatch [--max-scope N]] [--plan p] [--store s]   (N 1..3)");
      return 2;
    }
    const maxScope = flags["max-scope"] === undefined ? MAX_SCOPE : /^[1-3]$/.test(String(flags["max-scope"])) ? Number(flags["max-scope"]) : NaN;
    if (Number.isNaN(maxScope)) {
      out("usage: pnpm trace plan-lint [--pre-dispatch [--max-scope N]] [--plan p] [--store s]   (N 1..3)");
      return 2;
    }
    // The cross-checks read the store; one that does not replay cannot vouch for any node.
    if (state.errors.length) {
      out({ ok: false, error: `the record store does not replay (${state.errors.length} error(s)) — the plan cannot be checked against it; run pnpm trace lint`, store: storePath }, true);
      return 2;
    }
    const plan = readPlan();
    const preDispatch = !!flags["pre-dispatch"];
    // The story ids (and their AC numbers) a node's story:US-NNN#ACk token may name; none when there is no story map.
    const stories = new Map();
    try {
      const dir = join(ROOT, STORY_MAP_PATHS.stories);
      for (const f of readdirSync(dir).filter((x) => /^US-.*\.md$/.test(x))) {
        const st = parseStory({ path: `${STORY_MAP_PATHS.stories}/${f}`, text: readFileSync(join(dir, f), "utf8") });
        if (st.id) stories.set(st.id, new Set(st.acs));
      }
    } catch {
      // no stories/ directory: every story token dangles, as a warning
    }
    const { errors, warnings } = planViolations(plan, state, { preDispatch, maxScope, stories });
    for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    out({ ok: errors.length === 0, errors: errors.length, warnings: warnings.length, nodes: plan.nodes.length, preDispatch, plan: planPath, store: storePath }, true);
    return errors.length ? 1 : 0;
  }

  if (cmd === "plan-drift") {
    if (state.errors.length) {
      out({ ok: false, error: `the record store does not replay (${state.errors.length} error(s)); run pnpm trace lint`, store: storePath }, true);
      return 2;
    }
    const plan = readPlan();
    if (unparsed(plan)) return 1;
    // The base: --base-plan <file>, else the plan at --base <ref> (default: the last commit that touched the run log).
    let base = null;
    let baseFrom = "none";
    if (typeof flags["base-plan"] === "string") {
      try {
        base = parsePlan(readFileSync(resolve(flags["base-plan"]), "utf8"));
        baseFrom = flags["base-plan"];
      } catch {
        base = null;
      }
    } else {
      const ref = typeof flags.base === "string" ? flags.base : git(["log", "-1", "--format=%H", "--", ".claude/memory/loop-run-log.md"]);
      const rel = relative(ROOT, planPath);
      const text = ref && !rel.startsWith("..") ? git(["show", `${ref}:${rel}`]) : null;
      if (text) {
        base = parsePlan(text);
        baseFrom = `${ref}:${rel}`;
      }
    }
    const drift = planDrift(plan.nodes, base && !base.errors.length ? base.nodes : null, state);
    out({ ...drift, base: base && !base.errors.length ? baseFrom : "none (no readable base plan)", note: "advisory: consistency, not truth — never evidence in a TRACE record" }, true);
    return 0;
  }

  if (cmd === "plan-items") {
    if (flags.plan === true || !pos.length) {
      out("usage: pnpm trace plan-items <id> [<id>…] [--plan p] [--store s]");
      return 2;
    }
    // Whose record a node cites (its own loop:<id> record becomes priorRecordId) only the replayed
    // store tells, so one that does not replay yields no items. Errors go to stderr: stdout is the items file.
    if (state.errors.length) {
      process.stderr.write(`error: the record store does not replay (${state.errors.length} error(s)) — no items; run pnpm trace lint\n`);
      return 2;
    }
    const plan = readPlan();
    if (unparsed(plan)) return 1;
    // All or nothing: a batch with any id that is not ready is never half-emitted.
    const { items, refused } = planItems(plan.nodes, pos, state);
    for (const r of refused) process.stderr.write(`error: ${r.id}: ${r.reason}\n`);
    if (refused.length) return 1;
    out(items, true);
    return 0;
  }

  if (cmd === "story-lint") {
    if (flags.root === true) {
      out("usage: pnpm trace story-lint [--root <checkout>] [--store s]");
      return 2;
    }
    // The story map of this checkout (or --root's), each file read as text (null when missing). Every
    // path is joined to that checkout (so even a leading / stays in it) and counts only as a regular
    // file inside it: a cited spec that climbs out with ../ is not one. Errors go to stderr.
    const root = typeof flags.root === "string" ? resolve(flags.root) : ROOT;
    const isFile = (rel) => {
      const abs = join(root, rel);
      if (!abs.startsWith(root + sep)) return false;
      try {
        return statSync(abs).isFile();
      } catch {
        return false;
      }
    };
    const file = (rel) => ({ path: rel, text: isFile(rel) ? readFileSync(join(root, rel), "utf8") : null });
    let names = [];
    try {
      names = readdirSync(join(root, STORY_MAP_PATHS.stories)).filter((f) => /^US-.*\.md$/.test(f)).sort();
    } catch {
      // no stories/ directory: no story files
    }
    const map = {
      stories: names.map((f) => `${STORY_MAP_PATHS.stories}/${f}`).filter(isFile).map(file),
      ...Object.fromEntries(["index", "dashboard", "log", "coverage"].map((k) => [k, file(STORY_MAP_PATHS[k])])),
    };
    // The loop plan's nodes, for the per-story list of open nodes; a plan that is absent or does not parse adds nothing.
    const plan = readPlan();
    const planNodes = plan.errors.length ? undefined : plan.nodes;
    const { errors, warnings, stories, absent } = storyMapViolations(map, state, { specExists: isFile, planNodes });
    for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    out({ ok: errors.length === 0, errors: errors.length, warnings: warnings.length, stories, ...(absent ? { absent } : {}), storyMap: join(root, STORY_MAP), store: storePath }, true);
    return errors.length ? 1 : 0;
  }

  if (cmd === "wiki-check") {
    // Every cited fact must be on record and every committed fact still cited; a store that does not
    // replay can vouch for neither (its broken lines would read as "names no record").
    if (state.errors.length) {
      out({ ok: false, errors: [`the record store does not replay (${state.errors.length} error(s)) — the wiki cannot be checked against it; run pnpm trace lint`], warnings: [], store: storePath }, true);
      return 2;
    }
    const wiki = loadWiki();
    const { errors, warnings } = wikiViolations({ ...wiki, state });
    out({ ok: errors.length === 0, errors, warnings, pages: wiki.pages.length, store: storePath }, true);
    return errors.length ? 1 : 0;
  }

  if (cmd === "l3-check") {
    // The L3 measured-checker item, computed (l3Check): a store that does not replay, or a block that
    // cannot be read, is an unmet condition too — exit 1 unless every condition holds.
    const res = l3Check(state, currentVerifierHash());
    if (flags.json) out({ ...res, store: storePath }, true);
    else if (res.ok) {
      out(`l3-check: met — ${res.record_id} is accept from ${res.repeats} repeat(s) over the full manifest, with no F0, F3 or F4, and measured the current <loop-verifier> block (sha256 ${res.currentHash.slice(0, 12)}…)`);
    } else {
      out(`l3-check: NOT met — ${res.unmet.length} unmet condition(s); latest bench:trace-bench-lite record: ${res.record_id || "none"}\n${res.unmet.map((u) => `  - ${u}`).join("\n")}`);
    }
    return res.ok ? 0 : 1;
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
    // --severity answers the whole-store open-blocker check (critic-round.md, multi-agent-dev.md), so a missing or
    // unknown value (the schema's enum) is a usage error, never an empty list that would read as "no open blocker".
    const severities = schema.$defs.record.properties.severity.enum;
    if (flags.severity !== undefined && !severities.includes(flags.severity)) {
      out(`usage: pnpm trace query … --severity ${severities.join("|")}   (an exact match on a record's severity)`);
      return 2;
    }
    let recs = flags.latest ? [...latestByClaim(state.records, state.superseded).values()] : [...state.records.values()];
    if (flags["claim-id"]) recs = recs.filter((r) => r.claim_id === flags["claim-id"]);
    if (flags.status) recs = recs.filter((r) => r.final_status === flags.status);
    if (flags.severity) recs = recs.filter((r) => r.severity === flags.severity);
    if (flags.writer) recs = recs.filter((r) => r.writer_id.startsWith(flags.writer));
    if (flags.subject) recs = recs.filter((r) => r.subject === flags.subject);
    if (flags.brief) {
      process.stdout.write(JSON.stringify(briefRecords(recs, [...state.actions.values()].flat())) + "\n");
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
    const cands = reauditCandidates(state.records, state.superseded, changedSince, reachable);
    if (flags.act && cands.length) {
      const note = (c) => (c.unreachable ? `provenance commit ${c.unreachable} is unreachable — re-verify: ${c.paths.join(", ")}` : `evidence changed: ${c.changed.join(", ")}`);
      const res = appendActions(
        cands.map((c) => ({ record_id: c.record_id, consumer: "dream", action: "REAUDIT", note: note(c) })),
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
      const { benchPreconditionStep } = await import("./bench-judge.mjs");
      const stop = benchPreconditionStep(cmd, flags, manifest);
      if (stop) {
        out(stop.body, true);
        return stop.code;
      }
    }
    if (cmd === "bench-args") {
      const args = benchArgs(manifest, {
        runId: randomBytes(4).toString("hex"),
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
    // How many agents the workflow(s) started: a started run that never came back is counted
    // as missing (F0 validity), so a silently shrunken sample is never recorded as an accept.
    let expectedRuns = 0;
    let runs = refs.flatMap((ref) => {
      const raw = readJsonInput(ref);
      const res = raw && raw.runs ? raw : raw?.result || raw;
      expectedRuns += Math.max(0, Number(res?.agents) || 0);
      // Each run carries its workflow run's id, so coverage can tie it to its own transcripts.
      return Array.isArray(res?.runs) ? res.runs.map((r) => ({ ...r, runId: res.runId || undefined })) : [];
    });
    // Contamination scan (F0): any agent that RECEIVED a real fixture id or defect text (in
    // its prompt, tool results or injected context — see receivedText) saw ground truth;
    // its runs are excluded. Required for --record.
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
    runs = markContaminated(runs, keys);
    if (tdirs.length) runs = markUnscanned(runs, transcripts);
    const score = scoreBench(manifest, { runs, unattributedLeaks: unmatchedLeaks(runs, keys), expectedRuns });
    score.transcriptsScanned = transcripts.length;
    if (!tdirs.length) score.flags.push("F0 coverage: no --transcripts given — the contamination scan did not run; these numbers are not a measurement");
    if (flags.record && runs.some((r) => !r.runId)) {
      out(score, true);
      out("--record refused: run(s) without a run id (args not from `pnpm trace bench-args`) cannot be tied to their own transcripts (F0)");
      return 1;
    }
    const runIds = [...new Set(runs.map((r) => r.runId).filter(Boolean))].sort();
    // One args file per Workflow run: two runs sharing a run id could vouch for each other.
    const recordedRunIds = new Set(
      [...state.records.values()]
        .filter((r) => r.claim_id === "bench:trace-bench-lite")
        .flatMap((r) => r.evidence.flatMap((e) => (/\[runs ([0-9a-f,]+)\]/.exec(e.ref || "") || ["", ""])[1].split(",").filter(Boolean))),
    );
    if (flags.record && runIds.some((id) => recordedRunIds.has(id))) {
      out(score, true);
      out("--record refused: this run id is already recorded — run `pnpm trace bench-args` afresh for every new run; only a resume of a cut-off run keeps its args file (F0)");
      return 1;
    }
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
      const res = writeRecords([benchRecordDraft(score, { resultsRef, priorRecordId: prior && prior.record_id, runIds, verifierHash: currentVerifierHash() })], { storePath, now, policyVersion, commit, branch, schema, forbidden: benchForbidden() });
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
