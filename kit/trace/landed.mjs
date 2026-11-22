// The landed predicate — the PURE core that decides whether a done plan node's change is in the
// project's HEAD (phase C, goal C5). The loop applies a verified patch to the working tree and CLEARs
// the node; the change lands only when someone commits it. What the CLEAR recorded (its note's
// `patch-id` and `commit` tokens), a human LAND, and facts the git adapter supplies (kit/trace/cli.mjs)
// decide. "Cannot tell" is unknown, never "not landed"; a node CLEARed before this change counts as
// landed (legacy), so existing plans behave the same.

const HEX = (min, max) => `[0-9a-f]{${min},${max}}`;
const token = (name, re) => (note) => new RegExp(`(?:^|[;\\s])${name} (${re})(?=$|[;\\s])`).exec(String(note || ""))?.[1] || null;
const baseOf = token("base", HEX(7, 64));
const patchIdOf = token("patch-id", HEX(40, 64));
const commitOf = token("commit", HEX(7, 64));

/** The landing tokens of a CLEAR note: { base, patchId, commit } (each or null). */
export function landingOf(note) {
  return { base: baseOf(note), patchId: patchIdOf(note), commit: commitOf(note) };
}

const actionsOn = (state, recordId, action) => (state?.actions?.get(recordId) || []).filter((a) => a.action === action);

/** What a done node's record says about its landing: its own CLEAR (ref = the node) and a human LAND. */
export function nodeLanding(node, state) {
  const clear = actionsOn(state, node.record, "CLEAR").filter((a) => a.ref === node.id).pop() || null;
  const land = actionsOn(state, node.record, "LAND").some((a) => a.ref === node.id && a.consumer === "human");
  return { id: node.id, clear: clear ? landingOf(clear.note) : null, land };
}

/**
 * The landed table. facts (from the adapter, each true | false | null = cannot tell):
 *   ancestor  the recorded commit is an ancestor of HEAD
 *   patchId   a non-merge commit in HEAD's history has the recorded patch-id
 *   trailer   a commit in HEAD's history carries the trailer "Plan: <node id>"
 * → { status: "landed" | "unknown", why }
 */
export function landedStatus({ clear, land }, facts = {}) {
  if (land) return { status: "landed", why: "human" };
  if (!clear || (!clear.patchId && !clear.commit)) return { status: "landed", why: "legacy" };
  if (facts.ancestor === true) return { status: "landed", why: "ancestor" };
  if (facts.patchId === true) return { status: "landed", why: "patch-id" };
  if (facts.trailer === true) return { status: "landed", why: "trailer" };
  const unsure = [facts.ancestor, facts.patchId, facts.trailer].some((f) => f !== false);
  return { status: "unknown", why: unsure ? "git cannot tell" : "not in HEAD's history" };
}

/**
 * Map(node id → { status, why }) for every done node. factsOf is the git port: it is asked once per
 * done node that recorded a patch-id or a commit, with { id, base, patchId, commit }.
 */
export function landedMap(nodes, state, factsOf) {
  const out = new Map();
  for (const n of nodes) {
    if (n.status !== "done") continue;
    const l = nodeLanding(n, state);
    const needsGit = !l.land && l.clear && (l.clear.patchId || l.clear.commit);
    out.set(n.id, landedStatus(l, needsGit ? factsOf({ id: n.id, ...l.clear }) : {}));
  }
  return out;
}

/** Whether a done node satisfies `after`: with no port, every done node does (today's behaviour). */
export const isLanded = (landed, id) => !landed || landed.get(id)?.status === "landed";
