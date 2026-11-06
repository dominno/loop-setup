// Loop-plan DAG tooling — `pnpm trace plan-ready`, `plan-lint` and `plan-items` over the table
// under "## Plan" in .claude/memory/loop-plan.md.
//
// It checks consistency, not truth: that the table parses, that readiness follows loop-plan.md's
// ready-node rule, and that each node's status agrees with the TRACE records it cites. It cannot
// tell whether a fix is right, whether a `missing` was really supplied, or whether the Lead chose
// the right citation.
//
// It lives under scripts/trace/, which the loop denylist covers, so a loop cannot weaken the gate
// that picks its own work. Pure (no fs / git): cli.mjs reads the plan and replays the store.
import { join } from "node:path";
import { LICENSING, ROOT } from "./lib.mjs";

export const DEFAULT_PLAN = join(ROOT, ".claude/memory/loop-plan.md");
/** The plan table's header, exactly (loop-plan.md, Node schema). */
export const PLAN_COLUMNS = ["id", "description", "after", "status", "record", "missing", "origin", "notes"];
/** The node statuses loop-plan.md defines (Node schema, `status`). */
export const STATUSES = ["ready", "blocked", "in-progress", "deferred", "done", "escalated", "dropped"];
/** The statuses the ready-node rule excludes (loop-plan.md, Ready-node rule). */
export const NOT_READY = ["done", "dropped", "escalated", "in-progress", "deferred"];
/** A node whose dependency is one of these can never become ready (stranded). A deferred one strands nothing. */
const STRANDING = ["dropped", "escalated"];
const LIVE = ["ready", "blocked", "in-progress", "deferred"];
const ID_RE = /^LP-\d{3,}$/;
const RECORD_RE = /^TR-[0-9a-f]{12}$/;
const CITED_RE = /\bTR-[0-9a-f]{12}\b/g;
const EMPTY_CELLS = ["", "—", "–", "-"];
/**
 * The attempt budget (loop.md step 9, the >3-attempts red flag): every attempt on a node counts —
 * each defer (an agent-failed one included) and each revise (a verifier's, or the Lead's failed
 * post-apply check) on its loop:<id> claim. A fourth attempt escalates the node.
 */
export const MAX_ATTEMPTS = 3;
const ATTEMPT_VERDICTS = ["defer", "revise"];
/** A defer the loop cannot supply: its `missing` names a human decision (loop.md step 10). */
const HUMAN_DECISION = /\b(human|approv\w*|decision|product call|sign-?off)\b/i;
const VERIFIER_WRITER = "loop-iteration/verify:";
const CRITIC_WRITER = "critic-panel/";

const at = (n) => `${n.id || "(no id)"} (line ${n.line})`;
const claimOf = (id) => `loop:${String(id).toLowerCase()}`;

// Split a table row on unescaped pipes; `\|` is a literal pipe inside a cell.
function splitRow(text) {
  const t = text.trim();
  const parts = t.split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && /(?<!\\)\|$/.test(t)) parts.pop();
  return parts.map((c) => c.replace(/\\\|/g, "|").trim());
}
const startsWithPipe = (v) => v.text.trimStart().startsWith("|");
const hasPipe = (v) => /(?<!\\)\|/.test(v.text);
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;

/**
 * Parse the table under "## Plan" (outside ``` fences) → { nodes, errors }. The table starts at the
 * section's first line that begins with a pipe and runs over the consecutive source lines that hold
 * an unescaped pipe: as in GFM, a row's leading pipe is optional, and a blank line, a heading or a
 * fence ends the table. GFM also reads any other non-blank line directly after a row as one more
 * (one-cell) row, so such a line is an error rather than read or skipped. Nodes keep table order:
 * { id, description, after: [ids], status, record, missing, origin, notes, line }. Anything that
 * keeps the table from being read as nodes is an error (a line with an unescaped pipe after the
 * table included), and the plan commands then refuse to compute readiness (fail closed).
 */
export function parsePlan(text) {
  const errors = [];
  const nodes = [];
  const visible = [];
  let fenced = false;
  String(text ?? "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.replace(/\r$/, "");
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced) visible.push({ text: line, line: i + 1 });
    });
  const heads = visible.filter((v) => /^##\s+Plan\s*$/.test(v.text));
  if (!heads.length) return { nodes, errors: ["[table] no '## Plan' section — the plan table lives under that heading"] };
  if (heads.length > 1) errors.push(`[table] line ${heads[1].line}: a second '## Plan' section — keep exactly one`);
  const body = [];
  for (const v of visible.slice(visible.indexOf(heads[0]) + 1)) {
    if (/^#{1,2}\s/.test(v.text)) break;
    body.push(v);
  }
  const first = body.findIndex(startsWithPipe);
  if (first < 0) return { nodes, errors: [...errors, `[table] the '## Plan' section (line ${heads[0].line}) has no table — expected | ${PLAN_COLUMNS.join(" | ")} |`] };
  let last = first;
  // Consecutive source lines only: a fenced block is gone from `visible`, and it ends the table.
  while (last + 1 < body.length && body[last + 1].line === body[last].line + 1 && hasPipe(body[last + 1])) last += 1;
  const next = body[last + 1];
  if (next && next.line === body[last].line + 1 && next.text.trim() && !HEADING_RE.test(next.text)) {
    errors.push(`[table] line ${next.line}: a line directly after the plan table, with no blank line between — GFM shows it as one more table row, so it is never skipped: put a blank line after the table, or make it a full row (write a literal | as \\|)`);
  }
  for (const v of body.slice(last + 1).filter(hasPipe)) {
    errors.push(`[table] line ${v.line}: a row outside the plan table (a blank line, a line without a pipe or a fence split it off) — keep every node in one table, and write a literal | as \\|`);
  }
  const [head, separator, ...rows] = body.slice(first, last + 1);
  if (splitRow(head.text).join("|") !== PLAN_COLUMNS.join("|")) {
    return { nodes, errors: [...errors, `[header] line ${head.line}: the plan table header must be exactly | ${PLAN_COLUMNS.join(" | ")} |`] };
  }
  const sep = separator ? splitRow(separator.text) : [];
  if (sep.length !== PLAN_COLUMNS.length || !sep.every((c) => /^:?-+:?$/.test(c))) {
    return { nodes, errors: [...errors, `[header] line ${head.line + 1}: the header must be followed by its separator row (|---| × ${PLAN_COLUMNS.length})`] };
  }
  const seen = new Map();
  for (const r of rows) {
    const cells = splitRow(r.text);
    if (cells.length !== PLAN_COLUMNS.length) {
      errors.push(`[cells] line ${r.line}: a row needs ${PLAN_COLUMNS.length} cells, found ${cells.length} (write a literal | as \\|)`);
      continue;
    }
    const c = cells.map((x) => (EMPTY_CELLS.includes(x) ? "" : x));
    const node = {
      id: c[0],
      description: c[1],
      after: c[2].split(",").map((s) => s.trim()).filter((s) => !EMPTY_CELLS.includes(s)),
      status: c[3],
      record: c[4],
      missing: c[5],
      origin: c[6],
      notes: c[7],
      line: r.line,
    };
    if (!ID_RE.test(node.id)) errors.push(`[id] ${at(node)}: an id is LP- followed by 3 or more digits`);
    if (seen.has(node.id)) errors.push(`[duplicate-id] ${at(node)}: also on line ${seen.get(node.id)} — ids are never reused`);
    else seen.set(node.id, node.line);
    nodes.push(node);
  }
  return { nodes, errors };
}

/** The first row per id (a duplicate id is a parse error). */
function indexById(nodes) {
  const byId = new Map();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  return byId;
}

/**
 * loop-plan.md's ready-node rule, literally, in table order: a known status outside NOT_READY,
 * and every `after` id done. An unknown status is never ready. `max` keeps the first N.
 */
export function readyIds(nodes, { max } = {}) {
  const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.id));
  const ready = nodes.filter((n) => STATUSES.includes(n.status) && !NOT_READY.includes(n.status) && n.after.every((d) => done.has(d))).map((n) => n.id);
  return Number.isInteger(max) && max >= 0 ? ready.slice(0, max) : ready;
}

/** Every node that depends on `id` through `after` edges, directly or transitively (cycle-safe; `id` excluded). */
export function dependents(nodes, id) {
  const reverse = new Map();
  for (const n of nodes) {
    for (const d of n.after) {
      if (!reverse.has(d)) reverse.set(d, []);
      reverse.get(d).push(n.id);
    }
  }
  const seen = new Set([id]);
  const out = [];
  const queue = [id];
  while (queue.length) {
    for (const next of reverse.get(queue.shift()) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

// Each back edge of a depth-first walk over `after` closes one cycle; reported as a path.
function findCycles(nodes, byId) {
  const mark = new Map(); // id → 1 on the current path, 2 finished
  const path = [];
  const cycles = [];
  const visit = (id) => {
    mark.set(id, 1);
    path.push(id);
    for (const dep of byId.get(id).after) {
      if (!byId.has(dep)) continue; // dangling: its own rule
      if (mark.get(dep) === 1) cycles.push([...path.slice(path.indexOf(dep)), dep]);
      else if (!mark.has(dep)) visit(dep);
    }
    path.pop();
    mark.set(id, 2);
  };
  for (const n of nodes) if (!mark.has(n.id)) visit(n.id);
  return cycles;
}

const EMPTY_STATE = { records: new Map(), actions: new Map(), superseded: new Set(), latestOfClaim: new Map() };

/**
 * `pnpm trace plan-lint`: { errors, warnings } for a parsed plan (parsePlan's result, or a bare
 * node list) against a replayed store (lib.mjs replay()). Every message starts with its rule tag.
 * "Latest for its claim" depends on line order (a union merge can interleave it), so it only
 * warns; an `in-progress` node is an error only with preDispatch, since the contract test can run
 * mid-loop.
 */
export function planViolations(plan, state = EMPTY_STATE, { preDispatch = false } = {}) {
  const { nodes, errors: parseErrors } = Array.isArray(plan) ? { nodes: plan, errors: [] } : plan;
  const errors = [...parseErrors];
  const warnings = [];
  const byId = indexById(nodes);
  const actionsOn = (recordId, action) => (state.actions.get(recordId) || []).filter((a) => a.action === action);

  // --- structural rules ---
  for (const n of nodes) {
    if (!STATUSES.includes(n.status)) errors.push(`[status] ${at(n)}: unknown status "${n.status}" (one of ${STATUSES.join(", ")})`);
    for (const d of n.after) {
      if (!byId.has(d)) {
        errors.push(`[dangling] ${at(n)}: after names ${d}, which is not in the table — if ${d} was pruned as done, delete it from this after; if it was dropped, cascade-resolve this node instead (drop it, or re-point its after to a live node)`);
      }
    }
    const open = n.after.filter((d) => byId.has(d) && byId.get(d).status !== "done");
    if (n.status === "ready" && open.length) {
      errors.push(`[hand-set-ready] ${at(n)}: status ready, but ${open.map((d) => `${d} is ${byId.get(d).status}`).join(", ")} — readiness is computed (pnpm trace plan-ready); set it blocked`);
    }
    if ((n.status === "deferred" || n.status === "escalated") && !n.missing) {
      errors.push(`[missing] ${at(n)}: ${n.status} with an empty missing — name the evidence or human decision that would unblock it`);
    }
  }
  for (const cycle of findCycles(nodes, byId)) errors.push(`[cycle] ${cycle.join(" → ")}: these after edges form a cycle, so none of them can ever be ready`);
  const strandedBy = new Map();
  for (const n of nodes) {
    if (!STRANDING.includes(n.status)) continue;
    for (const d of dependents(nodes, n.id)) {
      if (!strandedBy.has(d)) strandedBy.set(d, []);
      strandedBy.get(d).push(`${n.id} (${n.status})`);
    }
  }
  for (const n of nodes) {
    if (LIVE.includes(n.status) && strandedBy.has(n.id)) {
      errors.push(`[stranded] ${at(n)}: it depends, directly or transitively, on ${strandedBy.get(n.id).join(", ")}, so it can never be ready — cascade-resolve it (drop it, re-point its after, or escalate it with origin 'cascade from <id>')`);
    }
  }

  // --- TRACE cross-checks ---
  const attemptsOf = new Map(); // claim_id → how many defer/revise records it has (each one an attempt)
  for (const r of state.records.values()) if (ATTEMPT_VERDICTS.includes(r.final_status)) attemptsOf.set(r.claim_id, (attemptsOf.get(r.claim_id) || 0) + 1);
  const cleared = new Map(); // claim_id → a record of it that carries a CLEAR (for loop:<id>, that node was done)
  for (const r of state.records.values()) if (actionsOn(r.record_id, "CLEAR").length) cleared.set(r.claim_id, r.record_id);
  for (const n of nodes) {
    if (n.record && !RECORD_RE.test(n.record)) errors.push(`[record-unknown] ${at(n)}: record must be one TRACE record id (TR- + 12 hex), got "${n.record}"`);
    else if (n.record && !state.records.has(n.record)) errors.push(`[record-unknown] ${at(n)}: record ${n.record} is not in the record store`);
    const cited = new Set(`${n.origin} ${n.notes}`.match(CITED_RE) || []);
    cited.delete(n.record); // reported above
    for (const id of cited) if (!state.records.has(id)) errors.push(`[record-unknown] ${at(n)}: its origin/notes cite ${id}, which is not in the record store`);

    const rec = state.records.get(n.record);
    const own = !!rec && rec.claim_id === claimOf(n.id);
    const holds = rec ? actionsOn(rec.record_id, "HOLD") : [];
    const heldForNode = holds.some((a) => a.ref === n.id);
    const problems = [];
    if (n.status === "done") {
      if (!n.record) problems.push("it cites no record");
      else if (rec) {
        if (!own) problems.push(`${rec.record_id} is about claim ${rec.claim_id}, not ${claimOf(n.id)}`);
        if (!String(rec.writer_id).startsWith(VERIFIER_WRITER)) problems.push(`${rec.record_id} was written by ${rec.writer_id}, not the loop-iteration verifier (${VERIFIER_WRITER}…)`);
        if (!LICENSING.includes(rec.final_status)) problems.push(`${rec.record_id} is a ${rec.final_status}, not accept/qualify`);
        if (state.superseded.has(rec.record_id)) problems.push(`${rec.record_id} has been superseded by a revision`);
        if (!actionsOn(rec.record_id, "CLEAR").some((a) => a.ref === n.id)) problems.push(`${rec.record_id} carries no CLEAR whose ref is ${n.id}`);
      }
      if (problems.length) errors.push(`[done-record] ${at(n)}: done needs the node's own loop-iteration verifier record (claim ${claimOf(n.id)}), accept/qualify, not superseded, with a CLEAR --ref ${n.id} — ${problems.join("; ")}`);
    }
    if (n.status === "deferred") {
      if (!n.record) problems.push("it cites no record");
      else if (rec) {
        if (rec.final_status !== "defer") problems.push(`${rec.record_id} is a ${rec.final_status}`);
        if (own) {
          if (!holds.length) problems.push(`${rec.record_id} carries no HOLD`);
        } else if (String(rec.writer_id).startsWith(CRITIC_WRITER)) {
          if (!heldForNode) problems.push(`the critic record ${rec.record_id} carries no HOLD --ref ${n.id} (pnpm trace act ${rec.record_id} loop HOLD --ref ${n.id})`);
        } else problems.push(`${rec.record_id} is neither its own ${claimOf(n.id)} record nor a critic-panel record`);
      }
      if (problems.length) errors.push(`[deferred-record] ${at(n)}: deferred needs a defer record with a HOLD — ${problems.join("; ")}`);
    }
    if (n.status === "escalated") {
      const cascade = /\bcascade from (LP-\d{3,})\b/.exec(n.origin);
      if (!n.record) problems.push("it cites no record");
      else if (rec && own) {
        if (!holds.length) problems.push(`${rec.record_id} carries no HOLD`);
      } else if (rec && cascade) {
        const ancestor = byId.get(cascade[1]);
        if (!ancestor) problems.push(`its origin names ${cascade[1]}, which is not in the table`);
        else {
          if (ancestor.status !== "escalated") problems.push(`its cascade ancestor ${ancestor.id} is ${ancestor.status}, not escalated`);
          if (ancestor.record !== rec.record_id) problems.push(`it cites ${rec.record_id}, not its cascade ancestor's record ${ancestor.record || "(none)"}`);
          if (!dependents(nodes, ancestor.id).includes(n.id)) problems.push(`it does not depend on ${ancestor.id} (after, directly or transitively)`);
        }
        if (!holds.length) problems.push(`${rec.record_id} carries no HOLD`);
      } else if (rec && String(rec.writer_id).startsWith(CRITIC_WRITER)) {
        const fits = rec.final_status === "revise" || rec.final_status === "reject" || (rec.final_status === "defer" && HUMAN_DECISION.test((rec.missing || []).join("; ")));
        if (!fits) problems.push(`the critic record ${rec.record_id} is a ${rec.final_status}${rec.final_status === "defer" ? " the loop can supply (its missing names no human decision)" : ""} — a critic-origin escalated node needs a revise, a reject or a human-decision defer`);
        if (!heldForNode) problems.push(`the critic record ${rec.record_id} carries no HOLD --ref ${n.id} (pnpm trace act ${rec.record_id} loop HOLD --ref ${n.id})`);
      } else if (rec) problems.push(`${rec.record_id} is neither its own ${claimOf(n.id)} record, an escalated ancestor's record (origin 'cascade from <id>'), nor a critic-panel record`);
      if (problems.length) errors.push(`[escalated-record] ${at(n)}: escalated needs a HOLDed record — ${problems.join("; ")}`);
    }
    // A ready or blocked node's own record becomes plan-items' priorRecordId once it is dispatched (the next verdict revises it).
    const relayed = own && ["ready", "blocked"].includes(n.status);
    if (rec && (relayed || ["done", "deferred", "escalated"].includes(n.status))) {
      const latest = state.latestOfClaim.get(rec.claim_id);
      if (latest && latest !== rec.record_id) {
        const why = relayed ? ` — plan-items would pass it on as priorRecordId, and the next verdict would fork the claim's revises chain` : "";
        warnings.push(`[latest] ${at(n)}: ${rec.record_id} is not the newest record for claim ${rec.claim_id} (${latest} is) — order-dependent (e.g. after a union merge); re-plan from the newest verdict${why}`);
      }
    }
    const attempts = attemptsOf.get(claimOf(n.id)) || 0;
    if (attempts > MAX_ATTEMPTS && LIVE.includes(n.status)) {
      errors.push(`[attempts] ${at(n)}: ${attempts} attempts on ${claimOf(n.id)} (defers and revises, agent-failed and failed post-apply checks included) — a fourth attempt escalates the node (loop.md step 9)`);
    }
    // Records are tied to a node by its id, so a reused id inherits the old node's defers and its CLEARed verdict.
    if (n.status !== "done" && cleared.has(claimOf(n.id))) {
      warnings.push(`[reused-id] ${at(n)}: ${n.status}, but claim ${claimOf(n.id)} already carries a CLEARed record (${cleared.get(claimOf(n.id))}), so this id was done before — ids are never reused, a pruned one included: renumber the node above the highest LP id ever used`);
    }
    if (n.status === "in-progress") {
      const msg = `[in-progress] ${at(n)}: in-progress — stale unless this iteration dispatched it; reset it to ready/blocked before dispatching (loop-plan.md, Stale in-progress recovery)`;
      (preDispatch ? errors : warnings).push(msg);
    }
  }
  return { errors, warnings };
}

/**
 * `pnpm trace plan-items <ids…>`: loop-iteration's args.items for ready nodes, in the order asked.
 * Each item is { id, description, priorRecordId?, missing? } and nothing else: the verifier sees
 * the item verbatim, and the bench measured this shape. A deferred node reset to ready keeps its
 * record and missing. missing passes on as is; the record becomes priorRecordId only when the
 * replayed store (`state`) shows it is the node's own loop:<id> record. loop-iteration writes the
 * new verdict with `revises: priorRecordId`, and revising a critic or an ancestor's record would
 * cross claims and supersede it, dropping a finding that is still open from the next critic
 * round's --latest priors. Without a store, no record is passed on (fail closed).
 * All or nothing: any id that is not ready, unknown or listed twice refuses the whole batch.
 */
export function planItems(nodes, ids, state = EMPTY_STATE) {
  const byId = indexById(nodes);
  const ready = new Set(readyIds(nodes));
  const refused = [];
  const seen = new Set();
  for (const id of ids) {
    const n = byId.get(id);
    if (seen.has(id)) refused.push({ id, reason: "listed twice" });
    else if (!n) refused.push({ id, reason: "not in the plan" });
    else if (!ready.has(id)) {
      const open = n.after.filter((d) => byId.get(d)?.status !== "done");
      refused.push({ id, reason: `not ready: ${NOT_READY.includes(n.status) || !STATUSES.includes(n.status) ? `status ${n.status}` : `waits on ${open.join(", ")}`}` });
    }
    seen.add(id);
  }
  if (refused.length) return { items: [], refused };
  const items = ids.map((id) => {
    const n = byId.get(id);
    const own = !!n.record && state.records.get(n.record)?.claim_id === claimOf(n.id);
    return { id: n.id, description: n.description, ...(own ? { priorRecordId: n.record } : {}), ...(n.missing ? { missing: n.missing } : {}) };
  });
  return { items, refused };
}
