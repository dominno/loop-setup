// Story-map consistency lint — `pnpm trace story-lint` over the evidence-based story map under
// STORY_MAP: the per-story files (stories/US-*.md), the user-stories.md index, the
// implementation-status.md dashboard, the story-verification-log.md and the e2e-coverage-map.md.
//
// It checks consistency, not truth: that the story files, the index and the dashboard list the
// same stories at the same status; that each status has what its level needs on paper (a
// verification-log row, a coverage row whose spec file exists, a Record: line); and that a cited
// TRACE record is the story's own licensing, committed, unrevised status record and licenses that
// very status with its level's evidence kinds (a 'Record: (pre-TRACE)' grandfather only warns). It
// cannot tell whether a story works, whether a log row was a real check, or whether the record's
// checker was right.
//
// Markdown tables are read heuristically (GFM pipe tables outside ``` fences, found by their
// column names), and every finding names the file and line. Pure (no fs / git): cli.mjs reads the
// files and replays the store. An absent story map passes vacuously.
import { LICENSING } from "./lib.mjs";

/**
 * The story map's directory, relative to the repo root. An adopter who namespaces the story map
 * (docs/adoption-guide.md, "Fix Problem 1") changes this one constant, e.g. to "docs/delivery".
 */
export const STORY_MAP = "docs";
/** Each story-map path relative to the repo root; all live under STORY_MAP, so they move with it. */
export const STORY_MAP_PATHS = {
  stories: `${STORY_MAP}/stories`,
  index: `${STORY_MAP}/user-stories.md`,
  dashboard: `${STORY_MAP}/implementation-status.md`,
  log: `${STORY_MAP}/story-verification-log.md`,
  coverage: `${STORY_MAP}/e2e-coverage-map.md`,
};
/** The story statuses, in the order of implementation-status.md's status model (a contract test keeps them in sync). */
export const STORY_STATUSES = ["Not started", "Partially implemented", "Implemented", "Unit tested", "E2E tested", "Browser verified", "Done", "Blocked", "Deprecated"];
// The evidence ladder, lowest first. Blocked and Deprecated sit outside it, so no "or higher" rule reaches them.
const LADDER = STORY_STATUSES.slice(0, 7);
const atLeast = (status, floor) => LADDER.indexOf(status) >= LADDER.indexOf(floor);
// Which of a story's claimed statuses its rules are checked at: the highest on the ladder. Blocked and
// Deprecated rank just above Not started, since like every status but Not started they need a Record: line.
const rank = (status) => (LADDER.includes(status) ? LADDER.indexOf(status) : 0.5);
/** The claim_id of a story's status records: lowercased, exactly as the scan-docs workflow writes it. */
export const storyClaim = (id) => `story:${String(id).toLowerCase()}:status`;

const ID_RE = /\bUS-\d+\b/g;
const FILE_RE = /^(US-\d+)(?:-[^/]*)?\.md$/;
const TR_RE = /\bTR-[0-9a-f]{12}\b/g;
const LABEL_RE = /^\*\*([^*]+):\*\*(.*)$/; // **Final status:** …, **Acceptance criteria:** …
const RECORD_RE = /^(?:[-*+]\s+)?Record:\s*(.*)$/;
const UNCHECKED_RE = /^[-*+]\s+\[ \]/;
/** The grandfather marker for a status set before TRACE-lite records existed (allowed below Browser verified). */
const PRE_TRACE = "(pre-TRACE)";
const COMMITS = ["COMMIT", "COMMIT_QUALIFIED"];
const EMPTY_STATE = { records: new Map(), actions: new Map(), superseded: new Set(), latestOfClaim: new Map(), errors: [] };
// Where a licensing status record names the status it licenses, as scan-docs writes it (the Lead's own
// record takes the same form): an accept in its claim_text, `Story <id> (<title>) is at status "<S>"`; a
// qualify in its qualifier, `holds only at "<S>"` — the lower status the verifier held it at, never the
// overclaimed proposal its claim_text keeps.
const LICENSED_IN = {
  accept: { field: "claim_text", phrase: 'is at status "<S>"', re: /is at status "([^"]*)"/g },
  qualify: { field: "qualifier", phrase: 'holds only at "<S>"', re: /holds only at "([^"]*)"/g },
};
// The evidence kinds a status record needs at a level, read from its evidence items: every group met
// by one of its kinds. Above the repo-evidence levels, the browser observation and the post-scan critic
// round's records; at the tested levels, a test run or a test file read.
const ROUND_EVIDENCE = { needs: [["browser"], ["record"]], why: "the browser observation, and the post-scan critic round's records" };
const TEST_EVIDENCE = { needs: [["command", "file_line"]], why: "a test run, or a test file read" };
const LEVEL_EVIDENCE = { "Unit tested": TEST_EVIDENCE, "E2E tested": TEST_EVIDENCE, "Browser verified": ROUND_EVIDENCE, Done: ROUND_EVIDENCE };

const norm = (s) => String(s ?? "").replace(/[`*]/g, "").trim();
const q = (s) => JSON.stringify(s);
const idsIn = (text) => [...new Set(String(text).match(ID_RE) || [])];
const linkText = (cell) => String(cell).replace(/\]\([^)]*\)/g, "]"); // [US-001](./stories/US-001-x.md) → [US-001]

// The lines outside ``` / ~~~ fences, numbered from 1.
function visibleLines(text) {
  const out = [];
  let fenced = false;
  String(text ?? "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.replace(/\r$/, "");
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced) out.push({ text: line, line: i + 1 });
    });
  return out;
}

// Split a table row on unescaped pipes; `\|` is a literal pipe inside a cell (GFM).
function splitRow(text) {
  const t = text.trim();
  const parts = t.split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && /(?<!\\)\|$/.test(t)) parts.pop();
  return parts.map((c) => c.replace(/\\\|/g, "|").trim());
}
const hasPipe = (text) => /(?<!\\)\|/.test(text);

// Every GFM pipe table: a header row, its separator (same cell count) and the consecutive pipe rows
// after it → { columns (lowercased header names), rows: [{ cells, line }] }.
function tables(text) {
  const lines = visibleLines(text);
  const found = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const [head, sep] = [lines[i], lines[i + 1]];
    if (sep.line !== head.line + 1 || !hasPipe(head.text) || !hasPipe(sep.text)) continue;
    const columns = splitRow(head.text).map((c) => c.toLowerCase());
    const marks = splitRow(sep.text);
    if (marks.length !== columns.length || !marks.every((c) => /^:?-+:?$/.test(c))) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].line === lines[j - 1].line + 1 && hasPipe(lines[j].text); j += 1) rows.push({ cells: splitRow(lines[j].text), line: lines[j].line });
    found.push({ columns, rows });
    i = j - 1;
  }
  return found;
}

// The first table of `file` that has every named column, with a cell reader by column name — or
// null after an error naming the file (a story-map file that exists must keep its table).
function tableIn(file, need, errors) {
  const t = tables(file.text).find((x) => need.every((c) => x.columns.includes(c.toLowerCase())));
  if (!t) {
    errors.push(`[table] ${file.path}: no table with the column${need.length > 1 ? "s" : ""} ${need.map(q).join(" and ")} — keep the story map's table headers`);
    return null;
  }
  return { rows: t.rows, cell: (row, column) => row.cells[t.columns.indexOf(column.toLowerCase())] ?? "" };
}

/**
 * One story file → { id (from its name US-<n>-<slug>.md), path, finalLine, status: {value, line},
 * record: {line, value, ids, preTrace}, unchecked: [{line, text}] }. The status is the first line
 * under **Final status:** (or that label's own line) that is not its Record: line; the Record: line
 * is read only in that section, and unchecked '- [ ]' items only under **Acceptance criteria:**.
 * A second **Final status:** label is listed in extraFinal (the first one counts).
 */
export function parseStory({ path, text }) {
  const story = { id: FILE_RE.exec(String(path).split("/").pop())?.[1] ?? null, path, finalLine: null, status: null, record: null, unchecked: [], acs: [], extraFinal: [] };
  const recordOf = (value, line) => {
    const v = norm(value);
    const ids = [...new Set(v.match(TR_RE) || [])];
    return { line, value: v, ids, preTrace: !ids.length && v.startsWith(PRE_TRACE) };
  };
  let section = "";
  const inFinal = () => section === "final status" && story.extraFinal.length === 0;
  for (const l of visibleLines(text)) {
    const t = l.text.trim();
    const label = LABEL_RE.exec(t);
    if (label && label[1].trim().toLowerCase() === "record" && inFinal()) {
      story.record ??= recordOf(label[2], l.line); // **Record:** TR-… under Final status
      continue;
    }
    if (label) {
      section = label[1].trim().toLowerCase();
      if (section === "final status" && story.finalLine !== null) story.extraFinal.push(l.line);
      else if (section === "final status") {
        story.finalLine = l.line;
        if (norm(label[2])) story.status = { value: norm(label[2]), line: l.line };
      }
      continue;
    }
    if (section === "acceptance criteria" && UNCHECKED_RE.test(t)) story.unchecked.push({ line: l.line, text: t });
    const ac = section === "acceptance criteria" ? /^[-*+]\s+\[[ xX]\]\s+AC(\d+)\b/.exec(t) : null;
    if (ac) story.acs.push(Number(ac[1]));
    if (!inFinal() || !t) continue;
    const rec = RECORD_RE.exec(t);
    if (rec) story.record ??= recordOf(rec[1], l.line);
    else story.status ??= { value: norm(t), line: l.line };
  }
  return story;
}

/**
 * `pnpm trace story-lint`: { errors, warnings, stories, absent } for a story map against a replayed
 * store (lib.mjs replay()). `map` = { stories: [{path, text}], index, dashboard, log, coverage },
 * each file { path, text } with text null when the file is missing; `specExists(path)` answers
 * whether a cited spec path, relative to the repo root, is a regular file inside the repo (a path
 * that climbs out with ../ is not, even when a file exists there). Every message starts with its
 * rule tag, then the story id and the file:line it is about. The status rules (3)-(7) apply at the
 * highest status any of the three places claims, so a raised projection is checked for the evidence
 * and the licensing record it claims, not only reported as a mismatch.
 */
export function storyMapViolations(map = {}, state = EMPTY_STATE, { specExists = () => false, planNodes } = {}) {
  const errors = [];
  const warnings = [];
  const file = (key) => ({ path: map[key]?.path ?? STORY_MAP_PATHS[key], text: map[key]?.text ?? null });
  const [index, dashboard, log, coverage] = ["index", "dashboard", "log", "coverage"].map(file);
  const storyFiles = map.stories || [];
  if (!storyFiles.length && index.text === null && dashboard.text === null) return { errors, warnings, stories: 0, absent: true };

  // --- the story files, and the index and dashboard rows (one per story) ---
  const stories = new Map();
  for (const f of storyFiles) {
    const s = parseStory(f);
    if (!s.id) errors.push(`[id] ${f.path}: a story file is named US-<n>-<slug>.md`);
    else if (stories.has(s.id)) errors.push(`[duplicate] ${s.id} (${f.path}:1): a second story file — ${stories.get(s.id).path} is the first; keep one file per story`);
    else stories.set(s.id, s);
  }
  // id → its first row { status, line, path } in the table, or null when that table cannot be read.
  const statusRows = (f, label, idColumn, statusColumn) => {
    if (f.text === null) {
      errors.push(`[file] ${f.path}: missing — the story map's ${label} lists every story with its status`);
      return null;
    }
    const t = tableIn(f, [idColumn, statusColumn], errors);
    if (!t) return null;
    const byId = new Map();
    for (const r of t.rows) {
      const ids = idsIn(linkText(t.cell(r, idColumn)));
      if (ids.length !== 1) {
        errors.push(`[id] ${f.path}:${r.line}: the ${label} row's ${q(idColumn)} cell must name exactly one story id (US-<n>), found ${ids.length ? ids.join(", ") : "none"}`);
        continue;
      }
      if (byId.has(ids[0])) errors.push(`[duplicate] ${ids[0]} (${f.path}:${r.line}): a second ${label} row — line ${byId.get(ids[0]).line} is the first; keep one row per story`);
      else byId.set(ids[0], { status: norm(t.cell(r, statusColumn)), line: r.line, path: f.path });
    }
    return byId;
  };
  const inIndex = statusRows(index, "index", "ID", "Status");
  const inDashboard = statusRows(dashboard, "dashboard", "Story", "Final status");
  // Rows of the log / coverage map that name stories, or null when the file has lost its table (then
  // that [table] error stands for the rule); a missing file has no rows.
  const storyRows = (f, need) => {
    if (f.text === null) return { rows: [], cell: () => "" };
    const t = tableIn(f, need, errors);
    return t && { rows: t.rows.map((r) => ({ ...r, ids: idsIn(t.cell(r, "Story ID")) })), cell: t.cell };
  };
  const logRows = storyRows(log, ["Story ID"]);
  const coverageRows = storyRows(coverage, ["Story ID", "E2E test file"]);

  // (1) one set of ids
  const listed = [
    ["index", inIndex, index.path],
    ["dashboard", inDashboard, dashboard.path],
  ];
  for (const id of new Set([...stories.keys(), ...(inIndex?.keys() ?? []), ...(inDashboard?.keys() ?? [])])) {
    const s = stories.get(id);
    const missing = [...(s ? [] : [`no story file ${STORY_MAP_PATHS.stories}/${id}-<slug>.md`]), ...listed.filter(([, rows]) => rows && !rows.has(id)).map(([label, , path]) => `no ${label} row in ${path}`)];
    if (!missing.length) continue;
    const row = inIndex?.get(id) ?? inDashboard?.get(id);
    const at = s ? `${s.path}:1` : `${row.path}:${row.line}`;
    errors.push(`[id-set] ${id} (${at}): ${missing.join("; ")} — the story files, the index and the dashboard list the same stories`);
  }

  const citations = [];
  for (const s of stories.values()) {
    // (2) the story file's status, and the same status in both tables
    if (!s.status) errors.push(`[status] ${s.id} (${s.path}:${s.finalLine ?? 1}): ${s.finalLine ? "nothing under **Final status:**" : "no **Final status:** line"} — write one of: ${STORY_STATUSES.join(", ")}`);
    else if (!STORY_STATUSES.includes(s.status.value)) errors.push(`[status] ${s.id} (${s.path}:${s.status.line}): ${q(s.status.value)} is not a story status (one of: ${STORY_STATUSES.join(", ")})`);
    for (const line of s.extraFinal) errors.push(`[status] ${s.id} (${s.path}:${line}): a second **Final status:** — line ${s.finalLine} is the first; keep one`);
    const claims = s.status ? [{ status: s.status.value, at: `${s.path}:${s.status.line}` }] : [];
    for (const [label, rows] of listed) {
      const r = rows?.get(s.id);
      if (!r) continue;
      claims.push({ status: r.status, at: `${r.path}:${r.line}` });
      if (s.status && r.status !== s.status.value) {
        errors.push(`[status] ${s.id} (${r.path}:${r.line}): the ${label} says ${q(r.status)}, but the story file says ${q(s.status.value)} (${s.path}:${s.status.line}) — the story file holds the recorded status: fix the ${label} to it (a raised status needs its licensing record first)`);
      }
    }

    // (3)-(6), and the status (7) checks a cited record against, at the highest status claimed anywhere
    // (the story file wins a tie)
    const known = claims.filter((c) => STORY_STATUSES.includes(c.status));
    const top = known.reduce((a, c) => (rank(c.status) > rank(a.status) ? c : a), known[0]);
    if (top) {
      const { status, at } = top;
      if (atLeast(status, "Unit tested") && logRows && !logRows.rows.some((r) => r.ids.includes(s.id))) {
        errors.push(`[verification-log] ${s.id} (${at}): ${status} needs at least one row for ${s.id} in ${log.path}${log.text === null ? " (the file is missing)" : ""} — log only checks that were actually run`);
      }
      if (atLeast(status, "E2E tested") && coverageRows) {
        const rows = coverageRows.rows.filter((r) => r.ids.includes(s.id));
        const cited = rows.flatMap((r) => specsIn(coverageRows.cell(r, "E2E test file")).map((p) => ({ p, line: r.line })));
        if (!cited.some((c) => specExists(c.p))) {
          const why = !rows.length ? `no row for ${s.id}${coverage.text === null ? " (the file is missing)" : ""}` : !cited.length ? `its rows (line ${rows.map((r) => r.line).join(", ")}) cite no spec file` : cited.map((c) => `${c.p} (line ${c.line}) is not a file in the repo`).join("; ");
          errors.push(`[e2e-coverage] ${s.id} (${at}): ${status} needs a row in ${coverage.path} whose cited spec file exists — ${why}`);
        }
      }
      if (atLeast(status, "Implemented") && s.unchecked.length) {
        const [first] = s.unchecked;
        warnings.push(`[unchecked-ac] ${s.id} (${s.path}:${first.line}): ${status} with ${s.unchecked.length} unchecked acceptance criteri${s.unchecked.length > 1 ? "a" : "on"} (${q(first.text)}) — check it off once it is met, or the status overclaims`);
      }
      const rec = s.record;
      if (status !== "Not started" && !rec?.ids.length) {
        if (!rec?.preTrace) {
          errors.push(`[record] ${s.id} (${at}): ${status} needs a Record: line under **Final status:** citing its licensing TRACE record (TR-…)${rec ? ` — ${s.path}:${rec.line} names none` : ""}; only a status set before TRACE-lite may carry 'Record: (pre-TRACE)'`);
        } else if (atLeast(status, "Browser verified")) {
          errors.push(`[record] ${s.id} (${at}): ${status} needs a TR record id on its Record: line (${s.path}:${rec.line}) — 'Record: (pre-TRACE)' is allowed only below Browser verified`);
        } else {
          warnings.push(`[pre-trace] ${s.id} (${s.path}:${rec.line}): ${status} is not backed by a TRACE record — 'Record: (pre-TRACE)' grandfathers a status set before TRACE-lite; re-sync the story with /sync-story-status to record it`);
        }
      }
    }
    for (const id of s.record?.ids ?? []) citations.push({ story: s, id, at: `${s.path}:${s.record.line}`, status: top?.status, statusAt: top?.at });
  }

  // (7) every cited TR id: the story's own status record — licensing, COMMITted, not superseded by a
  // revision — that licenses the very status the story is checked at, with that level's evidence kinds
  for (const c of citations) {
    const claim = storyClaim(c.story.id);
    if (state.errors?.length) {
      errors.push(`[store] ${c.story.id} (${c.at}): the record store does not replay (${state.errors.length} error(s)), so ${c.id} cannot be checked — run pnpm trace lint`);
      continue;
    }
    const rec = state.records.get(c.id);
    if (!rec) {
      errors.push(`[record-unknown] ${c.story.id} (${c.at}): ${c.id} is not in the record store`);
      continue;
    }
    const problems = [];
    if (rec.claim_id !== claim) problems.push(`it is about claim ${rec.claim_id}, not ${claim}`);
    if (!LICENSING.includes(rec.final_status)) problems.push(`it is a ${rec.final_status}, not accept/qualify`);
    if (!(state.actions.get(c.id) || []).some((a) => COMMITS.includes(a.action))) {
      problems.push(`it carries no COMMIT or COMMIT_QUALIFIED${LICENSING.includes(rec.final_status) ? ` (pnpm trace act ${c.id} story-status ${rec.final_status === "accept" ? "COMMIT" : "COMMIT_QUALIFIED"} --ref ${c.story.id})` : ""}`);
    }
    // A formal revision is structural (unlike [latest] below, it does not depend on line order).
    if (state.superseded?.has(c.id)) {
      const by = [...state.records.values()].find((r) => r.revises === c.id)?.record_id;
      problems.push(`it is superseded: ${by} revises it — cite the claim's latest licensing record`);
    }
    // What a record licenses is read only from a licensing record of the story's own claim.
    if (rec.claim_id === claim && LICENSING.includes(rec.final_status) && c.status) problems.push(...licenseProblems(rec, c.status, c.statusAt));
    if (problems.length) {
      errors.push(`[status-record] ${c.story.id} (${c.at}): a status cites its own licensing record (claim ${claim}, accept/qualify, COMMIT or COMMIT_QUALIFIED, not superseded) for that very status, with its level's evidence — ${c.id}: ${problems.join("; ")}`);
      continue;
    }
    const latest = state.latestOfClaim.get(claim);
    if (latest && latest !== c.id) {
      warnings.push(`[latest] ${c.story.id} (${c.at}): ${c.id} is not the newest record for claim ${claim} (${latest} is) — order-dependent (e.g. after a union merge); re-sync the story from the newest verdict`);
    }
  }
  // --- the loop plan's nodes per story (warning only: plan and story statuses never move each other) ---
  if (Array.isArray(planNodes)) {
    const LIVE_NODE = ["ready", "blocked", "in-progress", "deferred"];
    for (const s of stories.values()) {
      const open = planNodes.filter((n) => LIVE_NODE.includes(n.status) && (n.story || []).some((l) => l.id === s.id));
      if (!open.length) continue;
      const list = open.map((n) => `${n.id} (${n.status})`).join(", ");
      const done = s.status?.value === "Done";
      warnings.push(`[plan-nodes] ${s.id} (${s.path}:1): open plan nodes ${list}${done ? " — the story is Done while a live node still delivers it: re-check the status with /sync-story-status, or drop the node" : ""}`);
    }
  }
  return { errors, warnings, stories: stories.size, absent: false };
}

// Why a licensing record of the story's own claim does not license `status` (claimed at `where`): the
// one status it names (LICENSED_IN) must be that status, and its evidence items must carry that level's
// kinds (LEVEL_EVIDENCE).
function licenseProblems(rec, status, where) {
  const problems = [];
  const { field, phrase, re } = LICENSED_IN[rec.final_status];
  const named = [...new Set([...String(rec[field] ?? "").matchAll(re)].map((m) => m[1]))];
  if (!named.length) problems.push(`it names no status it licenses — its ${field} has no ${phrase}`);
  else if (named.length > 1) problems.push(`it names more than one status (${named.map(q).join(", ")}) in its ${field} — a status record licenses one`);
  else if (named[0] !== status) problems.push(`it licenses ${q(named[0])}, not ${q(status)} (${where})`);
  const level = LEVEL_EVIDENCE[status];
  const kinds = new Set((rec.evidence || []).map((e) => e?.kind));
  const lacking = (level?.needs ?? []).filter((group) => !group.some((k) => kinds.has(k))).map((group) => group.join(" or "));
  if (lacking.length) problems.push(`${status} needs a ${level.needs.map((g) => g.join(" or ")).join(" and a ")} evidence item (${level.why}) — it has no ${lacking.join(" and no ")} item`);
  return problems;
}

// The spec files an "E2E test file" cell cites: its code spans (or, without any, its words) that end
// in a file extension; a file:line suffix names the file. A markdown link is read by its text, as in an
// id cell (linkText), never by its target: [e2e/a.spec.ts](../e2e/a.spec.ts) cites e2e/a.spec.ts. A word
// ends at whitespace, a comma or a semicolon, or between two adjacent links (`][`), and sheds one leading
// `[` and one closing `]` (the brackets linkText leaves, the closing one also before a :line suffix) —
// never a bracket inside a path: e2e/users/[id].spec.ts is read whole.
function specsIn(cell) {
  const text = linkText(cell);
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const words = spans.length ? spans : text.split(/[\s,;]+|(?<=\])(?=\[)/).map((w) => w.replace(/^\[/, "").replace(/\](?=(?::\d+){0,2}$)/, ""));
  return [...new Set(words.map((w) => w.trim().replace(/:\d+(?::\d+)?$/, "")).filter((w) => /\.[A-Za-z0-9]+$/.test(w)))];
}
