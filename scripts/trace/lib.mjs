// TRACE-lite core — typed, versioned, append-only records for every adjudicated claim.
// Adapted from Chang & Chang, "TRACE: An Operational Reasoning Schema for Auditable
// Agentic Commitments" (arXiv:2607.12480). Policy + rationale:
// .claude/memory/topics/trace.md. Schema: .claude/trace/schema-v1.json.
//
// Everything above the "store I/O" section is pure (no fs / git) so it is unit-tested
// directly; the CLI (cli.mjs) wires it to the filesystem and git.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
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
  // Both licensing verdicts face the floor: a checker cannot dodge it by self-demoting
  // to qualify. Only types whose fallback IS qualify (causal, predictive) may qualify on
  // weaker evidence; for the rest a qualify without the needed kind becomes defer.
  const licensing = out.verdict === "accept" || out.verdict === "qualify";
  if (licensing && !rule.acceptNeeds.some((k) => kinds.has(k)) && (out.verdict === "accept" || rule.onFail !== "qualify")) {
    out.failedGates.push(`evidence-gate:${out.claimType}:${out.verdict}-needs-${rule.acceptNeeds.join("|")}`);
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
// Re-typing must never lower the bar: gate the verdict under every candidate type (the
// maker's and the checker's) and keep the most conservative outcome.
function applyEvidenceGateStrict(v, claimTypes) {
  const types = (claimTypes || []).filter((t, i, all) => EVIDENCE_POLICY[t] && all.indexOf(t) === i);
  if (types.length < 2) return applyEvidenceGate(types.length ? { ...(v || {}), claimType: types[0] } : v);
  const rank = (r) => (r.verdict === "accept" ? 2 : r.verdict === "qualify" ? 1 : 0);
  return types.map((t) => applyEvidenceGate({ ...(v || {}), claimType: t })).reduce((a, b) => (rank(b) < rank(a) ? b : a));
}
// </trace-evidence-gate>
export { VERDICTS, EVIDENCE_POLICY, applyEvidenceGate, applyEvidenceGateStrict };

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
      // Own-property lookup: a "__proto__" or "constructor" key must not resolve to an
      // Object.prototype member and slip past additionalProperties:false.
      if (Object.prototype.hasOwnProperty.call(props, k)) errs.push(...validate(props[k], v, root, `${path}.${k}`));
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
  // Policy v2: qualify faces the evidence floor too (except causal/predictive, whose
  // fallback is qualify). Version-gated so records written under v1 still replay.
  if (status === "qualify" && Number(rec.policy_version) >= 2) {
    const rule = EVIDENCE_POLICY[rec.claim_type];
    if (rule && rule.onFail !== "qualify" && !rule.acceptNeeds.some((k) => kinds.has(k))) {
      v.push(`evidence-gate: qualify of a ${rec.claim_type} claim needs evidence of kind ${rule.acceptNeeds.join("|")}`);
    }
  }
  if (status === "defer" && !(rec.missing || []).length) v.push("defer needs a non-empty missing[] (name the evidence that would resolve it)");
  if (status === "revise" && !rec.repair) v.push("revise needs a repair (the restated claim or bounded fix)");
  if (rec.revises && rec.revises === rec.record_id) v.push("a record cannot revise itself");
  if (rec.reuses && rec.reuses === rec.record_id) v.push("a record cannot reuse itself");
  return v;
}

export function makeId(prefix, obj) {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 12)}`;
}

/** Drop only the entry's OWN id field (an action's `record_id` is a reference, not its id). */
function withoutOwnId(entry) {
  const rest = { ...entry };
  delete rest[entry.kind === "action" ? "action_id" : "record_id"];
  return rest;
}

/** The id a record/action MUST carry: a hash of everything except its own id (tamper check). */
export function expectedId(entry) {
  return makeId(entry.kind === "action" ? "TA" : "TR", withoutOwnId(entry));
}

/** Content identity ignoring writer time — two writes of the same draft share it. */
export function contentKey(entry) {
  const rest = withoutOwnId(entry);
  delete rest.created_at;
  return JSON.stringify(rest);
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
  // The id is writer-owned and content-addressed: never taken from the draft, so lint can
  // detect any in-place rewrite of a stored line.
  rec.record_id = expectedId(rec);
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
  a.action_id = expectedId(a);
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
  const latestOfClaim = new Map(); // claim_id → record_id of its newest record so far
  const contentKeys = new Map(); // contentKey → id (writer-side idempotency)
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
    if (id !== expectedId(v)) {
      errors.push(`${at}: ${id} does not match its content hash — the stored line was edited in place (records are immutable)`);
      continue;
    }
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
      latestOfClaim.set(v.claim_id, v.record_id);
      contentKeys.set(contentKey(v), v.record_id);
    } else {
      const rec = records.get(v.record_id);
      if (!rec) {
        errors.push(`${at}: action ${v.action_id} targets unknown or later record ${v.record_id}`);
        continue;
      }
      // Verdict-vs-action compatibility is merge-invariant → an error. "Was this the newest
      // record for its claim / already superseded?" depends on line ORDER, which a union
      // merge of two branches can interleave — so on replay it is only a warning; the
      // writer (appendActions) still enforces it strictly at append time.
      const hard = actionViolation(rec, v.action, null, null);
      if (hard) errors.push(`${at}: action ${v.action_id}: ${hard}`);
      else {
        const soft = actionViolation(rec, v.action, superseded, latestOfClaim);
        if (soft) warnings.push(`${at}: action ${v.action_id}: ${soft} (order-dependent — e.g. after a union merge)`);
      }
      contentKeys.set(contentKey(v), v.action_id);
      if (!actions.has(v.record_id)) actions.set(v.record_id, []);
      actions.get(v.record_id).push(v);
    }
  }
  return { errors, warnings, records, actions, superseded, latestOfClaim, contentKeys };
}

/** Why a consumer action on `rec` is not allowed (fail closed), or null if it is. */
export function actionViolation(rec, action, superseded, latestOfClaim) {
  const allowed = ACTION_ALLOWED[action];
  if (!allowed) return `unknown action ${action}`;
  if (!allowed.includes(rec.final_status)) {
    return `${action} is not allowed on a "${rec.final_status}" record (allowed: ${allowed.join("|")}) — fail closed`;
  }
  if (CLEARING_ACTIONS.includes(action) && superseded && superseded.has(rec.record_id)) {
    return `${action} on ${rec.record_id}, which has been superseded by a revision — act on the latest revision`;
  }
  // A newer record about the same claim (even one that does not formally `revises` this
  // one) makes this record stale: never clear a claim on an outdated verdict.
  const latest = latestOfClaim && latestOfClaim.get(rec.claim_id);
  if (CLEARING_ACTIONS.includes(action) && latest && latest !== rec.record_id) {
    return `${action} on ${rec.record_id}, but ${latest} is a newer record for claim ${rec.claim_id} — act on the latest record`;
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

/**
 * Paths whose changes never count toward the tree fingerprint: the records themselves and
 * the loop's/wiki's own bookkeeping (rewritten every iteration — counting them would make
 * verdict reuse impossible across /loop iterations without any code having changed).
 */
export const TREE_ID_EXCLUDES = [
  ".claude/memory/trace",
  ".claude/memory/loop-plan.md",
  ".claude/memory/loop-run-log.md",
  ".claude/memory/log.md",
  ".claude/memory/quarantine.md",
];

/**
 * Obvious secret shapes. The store is committed and immutable, so a secret that lands in
 * it can only be removed by rewriting history — the writer refuses such drafts instead.
 */
export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI/Anthropic-style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

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
  // Only decisions count as consumption — REUSE/REAUDIT are bookkeeping, not a consumer
  // acting on the verdict (else F5 could be satisfied by maintenance noise).
  const DECISIONS = ["CLEAR", "HOLD", "COMMIT", "COMMIT_QUALIFIED", "QUARANTINE", "REJECT"];
  const consumed = latest.filter((r) => (actions.get(r.record_id) || []).some((a) => DECISIONS.includes(a.action))).length;

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

  const consumerCoverage = latest.length ? consumed / latest.length : null;
  const flags = [];
  if (latest.length >= 10 && consumerCoverage < 0.5) {
    flags.push(`F5 archive-not-instrument: only ${Math.round(consumerCoverage * 100)}% of current claims were acted on by a consumer — cut fields or stop writing records nobody reads`);
  }
  return {
    flags,
    records: all.length,
    byStatus,
    byType,
    latestClaims: latest.length,
    consumerCoverage,
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
  // Runs carry opaque fixture tokens (see opaqueFixtureId); map them back to real ids.
  // Runs whose agent saw ground truth (markContaminated) are excluded, never scored.
  const byToken = new Map(manifest.fixtures.map((f) => [opaqueFixtureId(f.id), f.id]));
  const all = (Array.isArray(results?.runs) ? results.runs : []).map((r) => ({ ...r, fixtureId: byToken.get(r.fixtureId) || r.fixtureId }));
  const clean = all.filter((r) => !r.contaminated);
  // Validity: a run whose agent returned no verdict measured nothing — scoring it as a
  // hold would let a dead checker look perfect on the bad fixtures.
  const runs = clean.filter((r) => !r.noVerdict);
  const out = {
    fixtures: { bad: bad.length, good: good.length },
    contaminatedRuns: all.length - clean.length,
    noVerdictRuns: clean.length - runs.length,
    arms: {},
    flags: [],
  };
  if (out.contaminatedRuns) {
    out.flags.push(`F0 contamination: ${out.contaminatedRuns} run(s) had ground truth in their agent's transcript and were excluded — fix the leak before trusting this bench`);
  }
  // A leak in a transcript that cannot be attributed to a run can contaminate any run:
  // the measurement is not trustworthy at all (fail closed).
  out.unattributedLeaks = Number(results?.unattributedLeaks || 0);
  if (out.unattributedLeaks) {
    out.flags.push(`F0 contamination: ${out.unattributedLeaks} agent transcript(s) leaked ground truth but could not be tied to a run — this bench run is not a measurement`);
  }
  if (out.noVerdictRuns) {
    out.flags.push(`F0 validity: ${out.noVerdictRuns} run(s) returned no verdict and were excluded — the measured arm is smaller than it looks`);
  }

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
    // F4: the loop checker licensed a bad diff that the deterministic denylist does not
    // catch — exactly the case an unattended (L3) loop would ship.
    const wrongUndefended = ver.filter((r) => isBad(r.fixtureId) && !r.denylistHit && LICENSING.includes(r.verdict));
    if (wrongUndefended.length) {
      out.flags.push(`F4 wrong-accept: the loop verifier licensed ${wrongUndefended.length} bad diff run(s) the denylist does not catch — keep loops at ≤ L2 and tighten the verifier`);
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
/** Own keys that would rewrite the prototype instead of becoming data. */
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];
function dangerousKeys(obj, path = "$") {
  if (!obj || typeof obj !== "object") return [];
  const out = [];
  for (const k of Object.keys(obj)) {
    if (DANGEROUS_KEYS.includes(k)) out.push(`${path}.${k}`);
    else out.push(...dangerousKeys(obj[k], `${path}.${k}`));
  }
  return out;
}

/** Screening shared by records AND actions (a note or ref lands in the same store). */
function screenText(text, forbidden) {
  const v = [];
  if (forbidden.some((m) => text.includes(m))) v.push("contains bench ground truth (a fixture id, defect text or patch-only token) — redact it; the store is greppable by bench agents");
  if (SECRET_PATTERNS.some((re) => re.test(text))) v.push("looks like it contains a secret (key/token/private key) — redact it; the store is committed and immutable");
  return v;
}

export function writeRecords(drafts, { storePath, now, policyVersion, commit, branch, schema, forbidden = [] }) {
  const sch = schema || loadSchema();
  const prior = replay(loadEntries(storePath), sch, policyVersion);
  const known = new Map(prior.records);
  const contents = new Map(prior.contentKeys);
  const unsafe = drafts.map((d) => dangerousKeys(d));
  const batch = drafts.map((d, i) => (unsafe[i].length ? { kind: "record", record_id: "(refused)" } : finalizeRecord(d, { now, policyVersion, commit, branch })));
  const results = batch.map((rec, i) => {
    if (unsafe[i].length) return { rec, violations: [`draft carries prototype-polluting key(s): ${unsafe[i].join(", ")}`] };
    const violations = [...validate(sch.$defs.record, rec, sch), ...semanticViolations(rec)];
    if (known.has(rec.record_id)) violations.push(`duplicate record_id ${rec.record_id}`);
    const ck = contentKey(rec);
    if (contents.has(ck)) violations.push(`duplicate content — this exact record is already stored as ${contents.get(ck)} (re-running a write is not a new verdict)`);
    contents.set(ck, rec.record_id);
    violations.push(...screenText(JSON.stringify(rec), forbidden));
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
/** Bookkeeping events that legitimately repeat (each reuse / re-audit is a new event). */
export const EVENT_ACTIONS = ["REUSE", "REAUDIT"];

export function appendActions(drafts, { storePath, now, policyVersion, schema, forbidden = [] }) {
  const sch = schema || loadSchema();
  const prior = replay(loadEntries(storePath), sch, policyVersion);
  const batch = drafts.map((d) => finalizeAction(d, { now }));
  const contents = new Map(prior.contentKeys);
  const seenIds = new Set();
  const results = batch.map((a) => {
    // Idempotency without poisoning: an identical decision that is already recorded (or
    // repeated in this batch) is a no-op, not a batch-failing error. Event actions are
    // de-duplicated only against an identical id (same content AND same time).
    const ck = contentKey(a);
    if (seenIds.has(a.action_id) || (!EVENT_ACTIONS.includes(a.action) && contents.has(ck))) {
      return { a, violations: [], noop: contents.get(ck) || a.action_id };
    }
    seenIds.add(a.action_id);
    contents.set(ck, a.action_id);
    const violations = validate(sch.$defs.action, a, sch);
    violations.push(...screenText(JSON.stringify(a), forbidden));
    const rec = prior.records.get(a.record_id);
    if (!rec) violations.push(`unknown record ${a.record_id} — a consumer cannot act on a record that does not exist`);
    else {
      const why = actionViolation(rec, a.action, prior.superseded, prior.latestOfClaim);
      if (why) violations.push(why);
    }
    return { a, violations };
  });
  const ok = results.every((r) => r.violations.length === 0);
  const toWrite = results.filter((r) => !r.noop).map((r) => r.a);
  if (ok && toWrite.length) {
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, toWrite.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
  return results.map(({ a, violations, noop }) => ({
    action_id: noop || a.action_id,
    record_id: a.record_id,
    action: a.action,
    validation: violations.length ? { fail: violations } : "pass",
    stored: ok,
    ...(noop ? { noop: true } : {}),
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
//
// Contamination rule: the bench agents run in THIS repo and grep it freely, so ground
// truth must never be readable as plain text in the tree. The fixtures (ids, classes,
// defects, judges AND patches) live in one gzip+base64 bundle, agents get opaque tokens,
// raw runs are never committed, and bench-score scans the agent transcripts for leaked
// ground truth (F0). The first bench run was contaminated exactly this way.

export const BENCH_DIR = join(ROOT, ".claude/trace/bench");
export const BENCH_BUNDLE = join(BENCH_DIR, "fixtures.bundle");

/** Decode the fixture bundle → { version, description, fixtures: [{ ..., patch: <diff text> }] }. */
export function decodeBench(text) {
  return JSON.parse(gunzipSync(Buffer.from(String(text).replace(/\s+/g, ""), "base64")).toString("utf8"));
}

/** Encode a manifest (patches inline) into the bundle text — deterministic, wrapped at 76 cols. */
export function encodeBench(manifest) {
  const b64 = gzipSync(Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"), { level: 9 }).toString("base64");
  return b64.replace(/(.{76})/g, "$1\n").replace(/\n?$/, "\n");
}

export function readBench(bundlePath = BENCH_BUNDLE) {
  return decodeBench(readFileSync(bundlePath, "utf8"));
}

/**
 * Distinctive tokens that only the fixture patches introduce (absent from the product
 * code): finding one next to "fixture"/"seeded" text tells an agent which diff is a
 * seeded defect, so they count as ground truth too. `codeText` = the concatenated
 * CODE_PATHS sources.
 */
export function patchOnlyTokens(manifest, codeText) {
  const toks = new Set();
  for (const f of manifest.fixtures || []) {
    for (const line of String(f.patch || "").split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const t of line.match(/[A-Za-z_][A-Za-z0-9_.-]{9,}/g) || []) toks.add(t);
    }
  }
  return [...toks].filter((t) => !String(codeText || "").includes(t));
}

/**
 * Code whose vocabulary is NOT distinctive (see patchOnlyTokens): the product sources plus
 * the machinery's own code. Prose (docs, prompts, the record store) is deliberately NOT
 * included — that is where a leak would land, so it must not whitelist itself.
 */
export const CODE_PATHS = ["src", "e2e", ".github", "scripts", ".claude/workflows", "package.json", "next.config.mjs", "playwright.config.ts", "tsconfig.json", "eslint.config.mjs", "vitest.config.ts"];

/**
 * Strings whose presence in an agent transcript — or anywhere in the tree — means ground
 * truth leaked: fixture ids, defect text, and (when codeText is given) patch-only tokens.
 */
export function leakMarkers(manifest, codeText) {
  const out = [];
  for (const f of manifest.fixtures || []) {
    out.push(f.id);
    if (f.defect) out.push(String(f.defect).slice(0, 60));
  }
  if (codeText !== undefined) out.push(...patchOnlyTokens(manifest, codeText));
  return out.filter((m) => m && m.length >= 8);
}

/**
 * Which bench agents saw ground truth: transcripts = [{ label, text }]. Returns the run
 * keys ({ arm, token, repeat?, critic? }) parsed from the leaking agents' labels.
 */
export function contaminatedRuns(transcripts, manifest) {
  const markers = leakMarkers(manifest);
  const keys = [];
  for (const t of transcripts) {
    if (!markers.some((m) => t.text.includes(m))) continue;
    let m;
    if ((m = /^bench-verify:(fx-[0-9a-f]{8})-r(\d+)-\d+$/.exec(t.label))) keys.push({ arm: "verifier", token: m[1], repeat: Number(m[2]) });
    else if ((m = /^bench-single:(fx-[0-9a-f]{8})-\d+$/.exec(t.label))) keys.push({ arm: "single-pass", token: m[1] });
    else if ((m = /^bench-panel:(fx-[0-9a-f]{8}):([a-z-]+)-\d+-\d+$/.exec(t.label))) keys.push({ arm: "panel", token: m[1], critic: m[2] });
    else keys.push({ arm: "unknown", label: t.label });
  }
  return keys;
}

/** Mark runs whose agent saw ground truth (scoreBench then excludes them and raises F0). */
export function markContaminated(runs, keys) {
  return runs.map((r) => {
    const hit = keys.some(
      (k) => k.arm === r.arm && k.token === r.fixtureId && (k.repeat === undefined || k.repeat === (r.repeat ?? 0)) && (k.critic === undefined || k.critic === r.critic),
    );
    return hit ? { ...r, contaminated: true } : r;
  });
}

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
    if (!/^diff --git /.test(String(f.patch || ""))) v.push(`${at}: patch must be inline unified-diff text (diff --git …)`);
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

/**
 * Opaque per-fixture token handed to agents instead of the fixture id. Real ids
 * ("B<nn>-<defect-slug>") leak both the bad/good class and the defect itself — the first
 * bench run caught the verifier citing the id as evidence. Deterministic, so scoring can
 * map results back without a side file.
 */
export function opaqueFixtureId(id) {
  return `fx-${createHash("sha256").update(`trace-bench:${id}`).digest("hex").slice(0, 8)}`;
}

/**
 * Fixtures whose patch no longer applies to the working tree (product code moved on).
 * Checked by bench-args/bench-judge — NOT by `pnpm test`, so routine product edits never
 * turn the main gate red. `applies(patch) → boolean` is injected.
 */
export function staleFixtures(manifest, applies) {
  return manifest.fixtures.filter((f) => !applies(f.patch)).map((f) => opaqueFixtureId(f.id));
}

/** The workflow args for .claude/workflows/trace-bench.js — no ground truth leaks to agents. */
export function benchArgs(manifest, { arms, repeat, critics, only }) {
  const fx = manifest.fixtures.filter((f) => !only || only.includes(f.id));
  return {
    fixtures: fx.map((f) => ({ id: opaqueFixtureId(f.id), item: f.item, patch: f.patch })),
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
    // Counts only — never fixture ids or defect text: the record store is in the tree the
    // next bench run's agents can grep (contamination rule above).
    evidence: [{ kind: "measurement", ref: `pnpm trace bench-score ${resultsRef}`, result: JSON.stringify({ arms: score.arms, externalJudgeGap: Object.fromEntries(Object.entries(score.externalJudgeGap || {}).map(([k, ids]) => [k, ids.length])), contaminatedRuns: score.contaminatedRuns }).slice(0, 4000) }],
    failed_gates: score.flags.map((x) => x.split(":")[0]),
    missing: [],
    // Excluded runs (contamination or no verdict) shrink the sample: the numbers hold
    // only for the runs that were actually measured.
    ...(score.contaminatedRuns || score.noVerdictRuns
      ? { final_status: "qualify", qualifier: `measured on the clean runs only — ${score.contaminatedRuns || 0} contaminated and ${score.noVerdictRuns || 0} no-verdict run(s) were excluded` }
      : { final_status: "accept" }),
    reason: "deterministic scoring of the raw bench runs against the manifest's ground truth; the flags are the pre-registered falsification criteria that fired",
    provenance: { workflow: "trace-bench" },
    ...(priorRecordId ? { revises: priorRecordId } : {}),
  };
}
