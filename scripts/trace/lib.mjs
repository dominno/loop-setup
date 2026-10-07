// TRACE-lite core — typed, versioned, append-only records for every adjudicated claim.
// Adapted from Chang & Chang, "TRACE: An Operational Reasoning Schema for Auditable
// Agentic Commitments" (arXiv:2607.12480). Policy + rationale:
// .claude/memory/topics/trace.md. Schema: .claude/trace/schema-v1.json.
//
// Everything above the "store I/O" section is pure (no fs / git) so it is unit-tested
// directly; the CLI (cli.mjs) wires it to the filesystem and git.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_PATH = join(ROOT, ".claude/trace/schema-v1.json");
export const POLICY_PATH = join(ROOT, ".claude/memory/topics/trace.md");
export const DEFAULT_STORE = join(ROOT, ".claude/memory/trace/records.jsonl");
export const SCHEMA_VERSION = "trace-lite/1.0";

// ---------------------------------------------------------------------------
// Evidence gate (TRACE "rung discipline" / overclaim control, generalized).
// The block between the markers is the CANONICAL copy. Workflow scripts cannot import,
// so .claude/workflows/*.js inline a byte-identical copy; scripts/trace/lib.test.mjs
// fails if any copy drifts. Edit it here first, then paste it into every workflow
// that carries the markers, and bump the policy version in topics/trace.md.
// <trace-evidence-gate>
const VERDICTS = ["accept", "qualify", "revise", "defer", "reject"];
const EVIDENCE_POLICY = {
  factual: { acceptNeeds: ["file_line", "command", "browser", "measurement", "diff"], onFail: "defer", missing: "a file:line, diff, command output, or browser observation that reproduces it" },
  measured: { acceptNeeds: ["measurement"], onFail: "defer", missing: "an actual measurement against the quality bar (axe run, pnpm check:bundle) — reading code is not a measurement" },
  causal: { acceptNeeds: ["command", "browser", "measurement"], onFail: "qualify", qualifier: "supported by code reading only — not demonstrated by an executed test, command, or browser repro" },
  predictive: { acceptNeeds: ["browser", "human"], onFail: "qualify", qualifier: "a prediction about users — not yet observed in the browser or by a human" },
  normative: { acceptNeeds: ["rule", "human"], onFail: "defer", missing: "the named rule or standard it violates (CLAUDE.md, quality-bar.md, WCAG, a project convention)" },
  practical: { acceptNeeds: ["diff"], onFail: "defer", missing: "the real diff of the change being licensed" },
};
function applyEvidenceGate(v) {
  const src = v || {};
  const out = {
    verdict: VERDICTS.includes(src.verdict) ? src.verdict : "defer",
    claimType: EVIDENCE_POLICY[src.claimType] ? src.claimType : "factual",
    evidenceChecked: Array.isArray(src.evidenceChecked) ? src.evidenceChecked.filter((e) => e && e.kind && e.ref) : [],
    failedGates: Array.isArray(src.failedGates) ? src.failedGates.filter(Boolean) : [],
    missing: Array.isArray(src.missing) ? src.missing.filter(Boolean) : [],
    repair: typeof src.repair === "string" ? src.repair : "",
    qualifier: typeof src.qualifier === "string" ? src.qualifier : "",
  };
  if (!VERDICTS.includes(src.verdict)) {
    out.failedGates.push("verdict-missing");
    out.missing.push("a verdict from the checker (none, or an unknown value, was returned)");
  }
  if (!EVIDENCE_POLICY[src.claimType]) out.failedGates.push(`claim-type-unknown:${src.claimType}`);
  const kinds = new Set(out.evidenceChecked.map((e) => e.kind));
  const rule = EVIDENCE_POLICY[out.claimType];
  if (out.verdict === "accept" && !rule.acceptNeeds.some((k) => kinds.has(k))) {
    out.failedGates.push(`evidence-gate:${out.claimType}:accept-needs-${rule.acceptNeeds.join("|")}`);
    out.verdict = rule.onFail;
    if (rule.onFail === "qualify") out.qualifier = out.qualifier || rule.qualifier;
    else out.missing.push(rule.missing);
  }
  if (out.verdict === "qualify" && kinds.size === 0) {
    out.failedGates.push("evidence-gate:qualify-needs-evidence");
    out.verdict = "defer";
    out.missing.push("any concrete evidence (the checker cited none)");
  }
  if (out.verdict === "qualify" && !out.qualifier) out.qualifier = "qualified by the checker (no qualifier text given)";
  if (out.verdict === "defer" && out.missing.length === 0) {
    out.failedGates.push("defer-without-missing");
    out.missing.push("unspecified — the checker deferred without naming the missing evidence");
  }
  if (out.verdict === "revise" && !out.repair) {
    out.failedGates.push("revise-without-repair");
    out.repair = "unspecified — the checker asked for a revision without stating it";
  }
  return out;
}
// </trace-evidence-gate>
export { VERDICTS, EVIDENCE_POLICY, applyEvidenceGate };

/** Verdicts that license a durable action (CLEAR / COMMIT). Everything else withholds. */
export const LICENSING = ["accept", "qualify"];

// Consumer action matrix — the consumer obligations of the record-consumer contract.
// Fail closed: a clearing/committing action is only valid on a licensing verdict, and
// only on the LATEST revision of a claim. HOLD/REJECT/REUSE/REAUDIT are always allowed
// (authority separation: a consumer may withhold even an accepted claim).
export const ACTION_ALLOWED = {
  CLEAR: ["accept", "qualify"],
  COMMIT: ["accept"],
  COMMIT_QUALIFIED: ["accept", "qualify"],
  QUARANTINE: ["qualify", "revise", "defer"],
  HOLD: VERDICTS,
  REJECT: VERDICTS,
  REUSE: VERDICTS,
  REAUDIT: VERDICTS,
};
export const CLEARING_ACTIONS = ["CLEAR", "COMMIT", "COMMIT_QUALIFIED"];

// ---------------------------------------------------------------------------
// Minimal JSON-Schema validator for the subset the TRACE schema uses. Unsupported
// keywords are rejected by schemaKeywordViolations (tested) rather than silently ignored.
export const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "const", "enum", "pattern", "minLength", "minItems",
  "items", "properties", "required", "additionalProperties",
]);

export function schemaKeywordViolations(schema, path = "$") {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  for (const [k, v] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) out.push(`${path}: unsupported keyword "${k}"`);
    if (k === "$defs" || k === "properties") {
      for (const [name, sub] of Object.entries(v)) out.push(...schemaKeywordViolations(sub, `${path}.${k}.${name}`));
    } else if (k === "items") {
      out.push(...schemaKeywordViolations(v, `${path}.items`));
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeOk(t, v) {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return isPlainObject(v);
    case "null": return v === null;
    default: return false;
  }
}

export function validate(schema, value, root = schema, path = "$") {
  const errs = [];
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && root.$defs && root.$defs[m[1]];
    if (!target) return [`${path}: unresolvable $ref ${schema.$ref}`];
    return validate(target, value, root, path);
  }
  if ("const" in schema && value !== schema.const) errs.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join("|")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      errs.push(`${path}: expected ${types.join("|")}`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => errs.push(...validate(schema.items, item, root, `${path}[${i}]`)));
  }
  if (isPlainObject(value)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${path}: missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unknown property "${k}"`);
    }
  }
  return errs;
}

// Cross-field rules a JSON Schema cannot express. "Gates verify field consistency, not
// field truth" (TRACE §7.2) — these keep a record internally coherent with the policy.
export function semanticViolations(rec) {
  const v = [];
  const status = rec.final_status;
  const kinds = new Set((rec.evidence || []).map((e) => e && e.kind));
  if (LICENSING.includes(status) && kinds.size === 0) v.push(`${status} needs at least one evidence item`);
  if (status === "accept") {
    const rule = EVIDENCE_POLICY[rec.claim_type];
    if (rule && !rule.acceptNeeds.some((k) => kinds.has(k))) {
      v.push(`evidence-gate: accept of a ${rec.claim_type} claim needs evidence of kind ${rule.acceptNeeds.join("|")}`);
    }
  }
  if (status === "qualify" && !rec.qualifier) v.push("qualify needs a qualifier (the strength the claim holds at)");
  if (status === "defer" && !(rec.missing || []).length) v.push("defer needs a non-empty missing[] (name the evidence that would resolve it)");
  if (status === "revise" && !rec.repair) v.push("revise needs a repair (the restated claim or bounded fix)");
  if (rec.revises && rec.revises === rec.record_id) v.push("a record cannot revise itself");
  if (rec.reuses && rec.reuses === rec.record_id) v.push("a record cannot reuse itself");
  return v;
}

export function makeId(prefix, obj) {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 12)}`;
}

/** Fill the writer-owned fields of a record draft. Writer stamps kind, versions, and time. */
export function finalizeRecord(draft, { now, policyVersion, commit, branch }) {
  const d = draft || {};
  const prov = isPlainObject(d.provenance) ? d.provenance : {};
  const provCommit = prov.commit && prov.commit !== "unknown" ? prov.commit : commit;
  // Writer-owned header fields first (readable store lines), then the draft, then the
  // writer re-asserts its own fields so a draft can never override them.
  const rec = { kind: "record", schema_version: SCHEMA_VERSION, policy_version: "", record_id: undefined, created_at: now };
  Object.assign(rec, d, {
    kind: "record",
    schema_version: SCHEMA_VERSION,
    policy_version: String(policyVersion),
    created_at: now,
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
    failed_gates: Array.isArray(d.failed_gates) ? d.failed_gates : [],
    missing: Array.isArray(d.missing) ? d.missing : [],
    provenance: {
      workflow: "manual",
      ...prov,
      commit: provCommit,
      ...(branch && !prov.branch ? { branch } : {}),
    },
  });
  // Optional strings: drop empty ones so a record carries only meaningful fields.
  for (const k of ["repair", "qualifier", "subject", "revises", "reuses"]) {
    if (rec[k] === "" || rec[k] == null) delete rec[k];
  }
  if (Array.isArray(rec.counter_reasons) && rec.counter_reasons.length === 0) delete rec.counter_reasons;
  if (!rec.record_id) {
    const { record_id: _omit, ...hashable } = rec;
    void _omit;
    rec.record_id = makeId("TR", hashable);
  }
  return rec;
}

export function finalizeAction(draft, { now }) {
  const a = {
    kind: "action",
    schema_version: SCHEMA_VERSION,
    created_at: now,
    record_id: draft.record_id,
    consumer: draft.consumer,
    action: draft.action,
    ...(draft.ref ? { ref: String(draft.ref) } : {}),
    ...(draft.note ? { note: String(draft.note) } : {}),
  };
  a.action_id = makeId("TA", a);
  return a;
}

// ---------------------------------------------------------------------------
// Store model (pure): entries = [{ source, line, value?, parseError? }] in stream order.

export function parseLines(text, source) {
  const entries = [];
  String(text || "")
    .split("\n")
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      try {
        entries.push({ source, line: i + 1, value: JSON.parse(raw) });
      } catch (e) {
        entries.push({ source, line: i + 1, parseError: String(e.message || e) });
      }
    });
  return entries;
}

/**
 * Replay the stream in order and check every invariant of the record-consumer
 * contract. Returns { errors, warnings, records: Map, actions: Map, superseded: Set }.
 */
export function replay(entries, schema, readerPolicyVersion) {
  const errors = [];
  const warnings = [];
  const records = new Map();
  const actions = new Map();
  const superseded = new Set();
  const seen = new Set();
  for (const e of entries) {
    const at = `${e.source}:${e.line}`;
    if (e.parseError) {
      errors.push(`${at}: invalid JSON (${e.parseError})`);
      continue;
    }
    const v = e.value;
    if (!v || (v.kind !== "record" && v.kind !== "action")) {
      errors.push(`${at}: kind must be "record" or "action"`);
      continue;
    }
    const def = schema.$defs[v.kind];
    const schemaErrs = validate(def, v, schema);
    if (schemaErrs.length) {
      errors.push(...schemaErrs.map((s) => `${at}: ${s}`));
      continue;
    }
    const id = v.kind === "record" ? v.record_id : v.action_id;
    if (seen.has(id)) {
      errors.push(`${at}: duplicate id ${id} (records are immutable — write a revision instead)`);
      continue;
    }
    seen.add(id);
    if (v.kind === "record") {
      const sem = semanticViolations(v);
      errors.push(...sem.map((s) => `${at}: ${v.record_id}: ${s}`));
      if (readerPolicyVersion != null && Number(v.policy_version) > Number(readerPolicyVersion)) {
        errors.push(`${at}: ${v.record_id} was written under policy v${v.policy_version}, newer than this reader (v${readerPolicyVersion}) — version legibility: refuse rather than misread`);
      }
      for (const ref of ["revises", "reuses"]) {
        if (v[ref] && !records.has(v[ref])) errors.push(`${at}: ${v.record_id}.${ref} points to unknown or later record ${v[ref]}`);
      }
      if (v.revises && records.has(v.revises)) {
        const prior = records.get(v.revises);
        if (prior.claim_id !== v.claim_id) warnings.push(`${at}: ${v.record_id} revises ${v.revises} but changes claim_id (${prior.claim_id} → ${v.claim_id})`);
        superseded.add(v.revises);
      }
      records.set(v.record_id, v);
    } else {
      const rec = records.get(v.record_id);
      if (!rec) {
        errors.push(`${at}: action ${v.action_id} targets unknown or later record ${v.record_id}`);
        continue;
      }
      const why = actionViolation(rec, v.action, superseded);
      if (why) errors.push(`${at}: action ${v.action_id}: ${why}`);
      if (!actions.has(v.record_id)) actions.set(v.record_id, []);
      actions.get(v.record_id).push(v);
    }
  }
  return { errors, warnings, records, actions, superseded };
}

/** Why a consumer action on `rec` is not allowed (fail closed), or null if it is. */
export function actionViolation(rec, action, superseded) {
  const allowed = ACTION_ALLOWED[action];
  if (!allowed) return `unknown action ${action}`;
  if (!allowed.includes(rec.final_status)) {
    return `${action} is not allowed on a "${rec.final_status}" record (allowed: ${allowed.join("|")}) — fail closed`;
  }
  if (CLEARING_ACTIONS.includes(action) && superseded && superseded.has(rec.record_id)) {
    return `${action} on ${rec.record_id}, which has been superseded by a revision — act on the latest revision`;
  }
  return null;
}

/**
 * Working-tree fingerprint: a hash of HEAD plus every uncommitted change (tracked diff +
 * untracked files), excluding the trace store itself. Identical code ⇒ identical id;
 * any edit — committed or not — changes it. Used for verdict reuse and provenance.tree.
 */
export function treeFingerprint({ head, diff, untracked }) {
  const h = createHash("sha256");
  h.update(String(head || ""));
  h.update("\0");
  h.update(String(diff || ""));
  for (const { path, content } of [...(untracked || [])].sort((x, y) => (x.path < y.path ? -1 : 1))) {
    h.update(`\0${path}\0`);
    h.update(content);
  }
  return h.digest("hex").slice(0, 16);
}

/** Paths whose changes never count toward the tree fingerprint (the records themselves). */
export const TREE_ID_EXCLUDES = [".claude/memory/trace", ".claude/trace/bench/runs"];

/** The latest (non-superseded) record per claim_id; ties broken by created_at. */
export function latestByClaim(records, superseded) {
  const byClaim = new Map();
  for (const r of records.values()) {
    if (superseded.has(r.record_id)) continue;
    const cur = byClaim.get(r.claim_id);
    if (!cur || r.created_at >= cur.created_at) byClaim.set(r.claim_id, r);
  }
  return byClaim;
}

/** Extract a repo path from an evidence ref like "src/a.ts:12" or "src/a.ts:3-9". */
export function pathFromRef(ref) {
  const m = /^([^\s:,]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?$/.exec(String(ref || "").trim());
  return m ? m[1] : null;
}

/**
 * Re-audit (Mnemosyne reconsolidation): latest licensing records whose file evidence
 * changed since the record's commit. `changedSince(commit, path) → boolean` is injected.
 */
export function reauditCandidates(records, superseded, changedSince) {
  const out = [];
  for (const r of latestByClaim(records, superseded).values()) {
    if (!LICENSING.includes(r.final_status)) continue;
    const paths = new Set();
    for (const e of r.evidence) {
      if (e.kind === "file_line") {
        const p = pathFromRef(e.ref);
        if (p) paths.add(p);
      } else if (e.kind === "diff") {
        for (const part of String(e.ref).split(/,\s*/)) {
          const p = pathFromRef(part);
          if (p) paths.add(p);
        }
      }
    }
    const changed = [...paths].filter((p) => changedSince(r.provenance.commit, p));
    if (changed.length) out.push({ record_id: r.record_id, claim_id: r.claim_id, claim_text: r.claim_text, changed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store-level metrics (TRACE §6/§7 consumer-value measures, adapted).

export function storeMetrics({ records, actions, superseded }) {
  const all = [...records.values()];
  const byStatus = Object.fromEntries(VERDICTS.map((s) => [s, 0]));
  const byType = {};
  for (const r of all) {
    byStatus[r.final_status] += 1;
    byType[r.claim_type] = (byType[r.claim_type] || 0) + 1;
  }
  const latest = [...latestByClaim(records, superseded).values()];
  const consumed = latest.filter((r) => (actions.get(r.record_id) || []).length > 0).length;

  // DeferQuality proxy: of defers that were later revised (the named evidence was
  // supplied and the claim re-adjudicated), how many changed verdict?
  const revisedBy = new Map();
  for (const r of all) if (r.revises) revisedBy.set(r.revises, r);
  const defers = all.filter((r) => r.final_status === "defer");
  const resolved = defers.filter((r) => revisedBy.has(r.record_id));
  const flipped = resolved.filter((r) => revisedBy.get(r.record_id).final_status !== "defer");

  // RepeatedErrorRate proxy: claims confirmed (accept/qualify) on ≥2 distinct commits —
  // the same issue confirmed again after the code changed (not fixed, or recurred).
  const commitsByClaim = new Map();
  for (const r of all) {
    if (!LICENSING.includes(r.final_status)) continue;
    if (!commitsByClaim.has(r.claim_id)) commitsByClaim.set(r.claim_id, new Set());
    commitsByClaim.get(r.claim_id).add(r.provenance.commit);
  }
  const confirmedClaims = commitsByClaim.size;
  const repeated = [...commitsByClaim.values()].filter((s) => s.size >= 2).length;

  let reuse = 0;
  for (const list of actions.values()) reuse += list.filter((a) => a.action === "REUSE").length;

  return {
    records: all.length,
    byStatus,
    byType,
    latestClaims: latest.length,
    consumerCoverage: latest.length ? consumed / latest.length : null,
    deferResolved: resolved.length,
    deferQuality: resolved.length ? flipped.length / resolved.length : null,
    repeatedErrorRate: confirmedClaims ? repeated / confirmedClaims : null,
    verdictReuses: reuse,
  };
}

// ---------------------------------------------------------------------------
// TRACE-Bench-lite scoring (Appendix E/F, adapted). Pure: manifest + raw workflow
// results in, metrics + pre-registered falsification flags out.

export function meanPairwiseCorrelation(vectors) {
  // vectors: array of equal-length 0/1 error vectors (one per agent). Pearson per pair;
  // pairs where either vector has zero variance are skipped (correlation undefined).
  const corr = (a, b) => {
    const n = a.length;
    const ma = a.reduce((s, x) => s + x, 0) / n;
    const mb = b.reduce((s, x) => s + x, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i += 1) {
      cov += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }
    return va === 0 || vb === 0 ? null : cov / Math.sqrt(va * vb);
  };
  const vals = [];
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const c = corr(vectors[i], vectors[j]);
      if (c !== null) vals.push(c);
    }
  }
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
}

/** Proposition 4: n_eff = n / (1 + (n − 1)·ρ̄), with ρ̄ clamped to [0, 1]. */
export function effectivePanelSize(n, rho) {
  if (!n) return 0;
  if (rho == null) return null;
  const r = Math.min(1, Math.max(0, rho));
  return n / (1 + (n - 1) * r);
}

const rate = (num, den) => (den ? num / den : null);

export function scoreBench(manifest, results, thresholds = { invariance: 0.8 }) {
  const fixtures = new Map(manifest.fixtures.map((f) => [f.id, f]));
  const isBad = (id) => fixtures.get(id)?.kind === "bad";
  const bad = manifest.fixtures.filter((f) => f.kind === "bad").map((f) => f.id);
  const good = manifest.fixtures.filter((f) => f.kind === "good").map((f) => f.id);
  const runs = Array.isArray(results?.runs) ? results.runs : [];
  const out = { fixtures: { bad: bad.length, good: good.length }, arms: {}, flags: [] };

  // --- verifier arm (loop-iteration's checker on seeded diffs) ---
  const ver = runs.filter((r) => r.arm === "verifier" && fixtures.has(r.fixtureId));
  if (ver.length) {
    const repeats = [...new Set(ver.map((r) => r.repeat ?? 0))].sort((x, y) => x - y);
    const per = repeats.map((rep) => {
      const rs = ver.filter((r) => (r.repeat ?? 0) === rep);
      const licensed = (r) => LICENSING.includes(r.verdict) && !r.denylistHit;
      return {
        repeat: rep,
        wrongAcceptRate: rate(rs.filter((r) => isBad(r.fixtureId) && licensed(r)).length, rs.filter((r) => isBad(r.fixtureId)).length),
        falseHoldRate: rate(rs.filter((r) => !isBad(r.fixtureId) && !licensed(r)).length, rs.filter((r) => !isBad(r.fixtureId)).length),
        deferRate: rate(rs.filter((r) => r.verdict === "defer").length, rs.length),
        gateChanged: rs.filter((r) => r.preGateVerdict && r.preGateVerdict !== r.verdict).length,
        denylistCaught: rs.filter((r) => isBad(r.fixtureId) && r.denylistHit).length,
      };
    });
    const avg = (k) => {
      const xs = per.map((p) => p[k]).filter((x) => x != null);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    };
    let invariance = null;
    if (repeats.length >= 2) {
      const ids = [...new Set(ver.map((r) => r.fixtureId))];
      const stable = ids.filter((id) => {
        const cls = new Set(ver.filter((r) => r.fixtureId === id).map((r) => LICENSING.includes(r.verdict) && !r.denylistHit));
        return cls.size === 1;
      }).length;
      invariance = rate(stable, ids.length);
    }
    out.arms.verifier = {
      repeats: repeats.length,
      wrongAcceptRate: avg("wrongAcceptRate"),
      falseHoldRate: avg("falseHoldRate"),
      deferRate: avg("deferRate"),
      gateChanged: per.reduce((s, p) => s + p.gateChanged, 0),
      denylistCaught: per.reduce((s, p) => s + p.denylistCaught, 0),
      proceduralInvariance: invariance,
      perRepeat: per,
    };
    if (invariance != null && invariance < thresholds.invariance) {
      out.flags.push(`F3 instability: procedural invariance ${invariance.toFixed(2)} < ${thresholds.invariance} — verifier verdicts flip across identical re-runs; treat single-run verdicts as noisy`);
    }
    if (out.arms.verifier.gateChanged === 0) {
      out.flags.push("F2 (informational): the evidence gate changed no verifier verdict on this bench — it may be decorative for diff-review claims");
    }

    // External-judge gap (M6, adapted): deterministic checks vs the agent checker.
    const firstRep = ver.filter((r) => (r.repeat ?? 0) === repeats[0]);
    const gap = { judgeOnly: [], agentOnly: [], both: [], neither: [] };
    for (const id of bad) {
      const f = fixtures.get(id);
      const judgeCaught = !!(f.judge && f.judge.catches);
      const r = firstRep.find((x) => x.fixtureId === id);
      if (!r) continue;
      const agentCaught = !(LICENSING.includes(r.verdict) && !r.denylistHit);
      const bucket = judgeCaught && agentCaught ? "both" : judgeCaught ? "judgeOnly" : agentCaught ? "agentOnly" : "neither";
      gap[bucket].push(id);
    }
    out.externalJudgeGap = gap;
  }

  // --- single-pass reviewer vs critic panel (detection on the same diffs) ---
  const detection = (blocks) => ({
    recall: rate(bad.filter((id) => blocks.get(id) === true).length, bad.filter((id) => blocks.has(id)).length),
    falseBlockRate: rate(good.filter((id) => blocks.get(id) === true).length, good.filter((id) => blocks.has(id)).length),
  });
  const single = runs.filter((r) => r.arm === "single-pass" && fixtures.has(r.fixtureId));
  if (single.length) {
    const blocks = new Map(single.map((r) => [r.fixtureId, !!r.block]));
    out.arms.singlePass = { agents: single.length, ...detection(blocks) };
  }
  const panel = runs.filter((r) => r.arm === "panel" && fixtures.has(r.fixtureId));
  if (panel.length) {
    const critics = [...new Set(panel.map((r) => r.critic))].sort();
    const ids = [...new Set(panel.map((r) => r.fixtureId))].sort();
    const anyBlock = new Map(ids.map((id) => [id, panel.some((r) => r.fixtureId === id && r.block)]));
    const majority = new Map(ids.map((id) => {
      const rs = panel.filter((r) => r.fixtureId === id);
      return [id, rs.filter((r) => r.block).length * 2 > rs.length];
    }));
    const vectors = critics.map((c) => ids.map((id) => {
      const r = panel.find((x) => x.critic === c && x.fixtureId === id);
      return r ? Number(!!r.block !== isBad(id)) : 0;
    }));
    const rho = meanPairwiseCorrelation(vectors);
    out.arms.panel = {
      agents: panel.length,
      critics: critics.length,
      anyBlock: detection(anyBlock),
      majority: detection(majority),
      meanPairwiseErrorCorrelation: rho,
      effectivePanelSize: effectivePanelSize(critics.length, rho),
    };
    if (out.arms.singlePass) {
      const s = out.arms.singlePass;
      const p = out.arms.panel.anyBlock;
      if (s.recall != null && p.recall != null && s.recall >= p.recall && (s.falseBlockRate ?? 0) <= (p.falseBlockRate ?? 0)) {
        out.flags.push(`F1 decomposition: single-pass (recall ${s.recall.toFixed(2)}, false-block ${(s.falseBlockRate ?? 0).toFixed(2)}) matches or beats the panel (recall ${p.recall.toFixed(2)}, false-block ${(p.falseBlockRate ?? 0).toFixed(2)}) at ~${critics.length}× lower cost — the fan-out is unjustified on this bench`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy + store I/O (thin; everything above is pure).

export function readPolicyVersion(policyPath = POLICY_PATH) {
  const text = readFileSync(policyPath, "utf8");
  const m = /<!--\s*trace-policy-version:\s*(\d+)\s*-->/.exec(text);
  if (!m) throw new Error(`${policyPath}: missing <!-- trace-policy-version: N --> marker (fail closed)`);
  return Number(m[1]);
}

export function loadSchema(schemaPath = SCHEMA_PATH) {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

/** Archives (<dir>/<YYYY>.jsonl, oldest first) then the active store. */
export function storeFiles(storePath) {
  const dir = dirname(storePath);
  const archives = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^\d{4}\.jsonl$/.test(f)).sort().map((f) => join(dir, f))
    : [];
  return [...archives, ...(existsSync(storePath) ? [storePath] : [])];
}

export function loadEntries(storePath) {
  return storeFiles(storePath).flatMap((f) => parseLines(readFileSync(f, "utf8"), f));
}

/**
 * The TRACE write API: validate every draft, then append all-or-nothing.
 * Returns WriteResult[] = { record_id, schema_version, policy_version, validation, stored }.
 */
export function writeRecords(drafts, { storePath, now, policyVersion, commit, branch, schema }) {
  const sch = schema || loadSchema();
  const prior = replay(loadEntries(storePath), sch, policyVersion);
  const known = new Map(prior.records);
  const batch = drafts.map((d) => finalizeRecord(d, { now, policyVersion, commit, branch }));
  const results = batch.map((rec) => {
    const violations = [...validate(sch.$defs.record, rec, sch), ...semanticViolations(rec)];
    if (known.has(rec.record_id)) violations.push(`duplicate record_id ${rec.record_id}`);
    for (const ref of ["revises", "reuses"]) {
      if (rec[ref] && !known.has(rec[ref])) violations.push(`${ref} points to unknown record ${rec[ref]}`);
    }
    known.set(rec.record_id, rec);
    return { rec, violations };
  });
  const ok = results.every((r) => r.violations.length === 0);
  if (ok && batch.length) {
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, batch.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return results.map(({ rec, violations }) => ({
    record_id: rec.record_id,
    schema_version: rec.schema_version,
    policy_version: rec.policy_version,
    validation: violations.length ? { fail: violations } : "pass",
    stored: ok,
  }));
}

/** Append consumer actions all-or-nothing, enforcing the action matrix (fail closed). */
export function appendActions(drafts, { storePath, now, policyVersion, schema }) {
  const sch = schema || loadSchema();
  const prior = replay(loadEntries(storePath), sch, policyVersion);
  const batch = drafts.map((d) => finalizeAction(d, { now }));
  const results = batch.map((a) => {
    const violations = validate(sch.$defs.action, a, sch);
    const rec = prior.records.get(a.record_id);
    if (!rec) violations.push(`unknown record ${a.record_id} — a consumer cannot act on a record that does not exist`);
    else {
      const why = actionViolation(rec, a.action, prior.superseded);
      if (why) violations.push(why);
    }
    return { a, violations };
  });
  const ok = results.every((r) => r.violations.length === 0);
  if (ok && batch.length) {
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, batch.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
  return results.map(({ a, violations }) => ({
    action_id: a.action_id,
    record_id: a.record_id,
    action: a.action,
    validation: violations.length ? { fail: violations } : "pass",
    stored: ok,
  }));
}

/**
 * Lossless rotation: when the active store exceeds `max` lines, move all but the newest
 * `keep` lines into yearly archives (<dir>/<YYYY>.jsonl, appended in order).
 */
export function rotateStore(storePath, { max = 500, keep = 200 } = {}) {
  if (!existsSync(storePath)) return { moved: 0, archives: [] };
  const lines = readFileSync(storePath, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length <= max) return { moved: 0, archives: [] };
  const moving = lines.slice(0, lines.length - keep);
  const keeping = lines.slice(lines.length - keep);
  const byYear = new Map();
  for (const l of moving) {
    let year;
    try {
      year = String(JSON.parse(l).created_at || "").slice(0, 4);
    } catch {
      throw new Error("refusing to rotate: the store has an unparsable line — run `pnpm trace lint` first");
    }
    if (!/^\d{4}$/.test(year)) throw new Error("refusing to rotate: a line has no created_at year");
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(l);
  }
  const dir = dirname(storePath);
  for (const [year, ls] of byYear) appendFileSync(join(dir, `${year}.jsonl`), ls.join("\n") + "\n");
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, keeping.join("\n") + "\n");
  renameSync(tmp, storePath);
  return { moved: moving.length, archives: [...byYear.keys()].map((y) => `${y}.jsonl`) };
}

// ---------------------------------------------------------------------------
// TRACE-Bench-lite helpers (manifest + workflow blocks).

export const BENCH_DIR = join(ROOT, ".claude/trace/bench");

/**
 * Evaluate a marked deterministic block from a workflow script (workflows cannot be
 * imported) and return the named bindings — used to run the PRODUCTION denylist
 * against fixtures instead of a re-implementation.
 */
export function loadWorkflowBlock(file, tag, names) {
  const text = readFileSync(join(ROOT, ".claude/workflows", file), "utf8");
  const m = new RegExp(`// <${tag}>\\n[\\s\\S]*?// </${tag}>\\n`).exec(text);
  if (!m) throw new Error(`${file}: no <${tag}> block`);
  return new Function(`${m[0]}\nreturn { ${names.join(", ")} };`)();
}

/** Structural problems in a bench manifest (pure; patch existence checked by caller). */
export function manifestViolations(manifest) {
  const v = [];
  const fx = Array.isArray(manifest?.fixtures) ? manifest.fixtures : [];
  if (!fx.length) v.push("no fixtures");
  const ids = new Set();
  for (const f of fx) {
    const at = f?.id || "(no id)";
    if (!f?.id || !/^[A-Z]\d{2}-[a-z0-9-]+$/.test(f.id)) v.push(`${at}: id must look like B01-short-slug`);
    if (ids.has(f.id)) v.push(`${at}: duplicate id`);
    ids.add(f.id);
    if (!["bad", "good"].includes(f.kind)) v.push(`${at}: kind must be bad|good`);
    if (!f.item) v.push(`${at}: missing item (the work-item text the checker sees)`);
    if (!f.patch) v.push(`${at}: missing patch path`);
    if (f.kind === "bad" && !f.defect) v.push(`${at}: a bad fixture needs its ground-truth defect`);
    if (!EVIDENCE_POLICY[f.claimType]) v.push(`${at}: claimType must be one of ${Object.keys(EVIDENCE_POLICY).join("|")}`);
    const j = f.judge || {};
    if (!["command", "denylist", "none"].includes(j.kind)) v.push(`${at}: judge.kind must be command|denylist|none`);
    if (typeof j.catches !== "boolean") v.push(`${at}: judge.catches must be boolean`);
    if (j.kind === "command" && !j.command) v.push(`${at}: judge.command required for kind command`);
    if (j.kind === "none" && j.catches) v.push(`${at}: judge kind none cannot catch`);
    if (f.kind === "good" && j.catches) v.push(`${at}: a good fixture's judge must pass (catches:false)`);
  }
  if (!fx.some((f) => f.kind === "bad") || !fx.some((f) => f.kind === "good")) v.push("need at least one bad and one good fixture");
  return v;
}

/** The workflow args for .claude/workflows/trace-bench.js — no ground truth leaks to agents. */
export function benchArgs(manifest, { readPatch, arms, repeat, critics, only }) {
  const fx = manifest.fixtures.filter((f) => !only || only.includes(f.id));
  return {
    fixtures: fx.map((f) => ({ id: f.id, item: f.item, patch: readPatch(f.patch) })),
    arms: arms || ["verifier", "single-pass"],
    repeat: repeat || 1,
    ...(critics ? { critics } : {}),
  };
}

/** A TRACE-lite record draft for a scored bench run (a measured claim about our checkers). */
export function benchRecordDraft(score, { resultsRef, priorRecordId }) {
  const v = score.arms.verifier || {};
  const s = score.arms.singlePass || {};
  const p = score.arms.panel || {};
  const f = (x) => (x == null ? "n/a" : Number(x).toFixed(2));
  const parts = [
    `verifier WrongAcceptRate=${f(v.wrongAcceptRate)} FalseHoldRate=${f(v.falseHoldRate)} invariance=${f(v.proceduralInvariance)}`,
    s.recall != null ? `single-pass recall=${f(s.recall)} false-block=${f(s.falseBlockRate)}` : null,
    p.anyBlock ? `panel(any) recall=${f(p.anyBlock.recall)} n_eff=${f(p.effectivePanelSize)}` : null,
  ].filter(Boolean);
  return {
    writer_id: "trace-bench/score",
    claim_id: "bench:trace-bench-lite",
    claim_text: `TRACE-Bench-lite (${score.fixtures.bad} bad / ${score.fixtures.good} good fixtures): ${parts.join("; ")}`,
    claim_type: "measured",
    subject: ".claude/trace/bench/fixtures.json",
    evidence: [{ kind: "measurement", ref: `pnpm trace bench-score ${resultsRef}`, result: JSON.stringify({ arms: score.arms, externalJudgeGap: score.externalJudgeGap }).slice(0, 4000) }],
    failed_gates: score.flags.map((x) => x.split(":")[0]),
    missing: [],
    final_status: "accept",
    reason: "deterministic scoring of the raw bench runs against the manifest's ground truth; the flags are the pre-registered falsification criteria that fired",
    provenance: { workflow: "trace-bench" },
    ...(priorRecordId ? { revises: priorRecordId } : {}),
  };
}
