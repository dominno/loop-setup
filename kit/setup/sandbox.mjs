// L3's sandbox posture — the PURE core that decides, from the Claude Code settings scopes, whether
// the sandbox is on and its unsandboxed fallback held closed (L3 requires both; without the sandbox
// the loop's Bash runs as the user and can rewrite the kit, its manifest and the settings, so
// sandbox-off L2 has no local tamper resistance).
//
// Hexagonal rule: no filesystem, environment or process here. The settings come from the driven
// adapter kit/setup/settings.mjs; `loop-setup l3-check` and `loop-setup doctor` are the driving adapters.

/**
 * The sandbox posture from the settings sources, given in Claude Code's precedence order
 * (managed > local > project > user): [{ scope, path, settings: object | null (absent) | { error } }].
 *   - the effective sandbox.enabled is the first boolean in that order (off when none sets it);
 *   - sandbox.allowUnsandboxedCommands must be held false: the first managed source that sets it
 *     decides (managed policy outranks the user — a managed true opens the fallback); otherwise a
 *     false in the user settings holds it, which a project cannot reopen (Claude Code: "held closed"),
 *     while a project-only false can be flipped back;
 *   - sandbox.excludedCommands must be empty in every scope: the commands it names run outside the
 *     sandbox with no filesystem restriction, so one of them could rewrite the kit (a value that is
 *     not a list fails closed);
 *   - a settings file that does not parse fails closed.
 * → { ok, enabled, enabledBy: scope|null, heldBy: scope|null, problems }
 */
export function sandboxPosture(sources) {
  const problems = sources.filter((s) => s.settings?.error).map((s) => `${s.path} does not parse (${s.settings.error}) — the sandbox posture cannot be read`);
  if (problems.length) return { ok: false, enabled: false, enabledBy: null, heldBy: null, problems };
  const set = sources.find((s) => typeof s.settings?.sandbox?.enabled === "boolean");
  const enabled = set?.settings.sandbox.enabled === true;
  if (!enabled) {
    problems.push(
      set
        ? `the sandbox is off: sandbox.enabled is false (${set.scope}: ${set.path}) — L3 needs sandbox.enabled: true in the effective settings`
        : "the sandbox is off: sandbox.enabled is not set in any settings scope (Claude Code's default is off) — L3 needs sandbox.enabled: true",
    );
  }
  const managed = sources.find((s) => s.scope === "managed" && typeof s.settings?.sandbox?.allowUnsandboxedCommands === "boolean");
  const user = sources.find((s) => s.scope === "user" && s.settings?.sandbox?.allowUnsandboxedCommands === false);
  const holder = managed ? (managed.settings.sandbox.allowUnsandboxedCommands === false ? managed : null) : user || null;
  if (!holder && managed) problems.push(`sandbox.allowUnsandboxedCommands is not held false at user scope: managed policy sets it true (${managed.path}), which outranks the user settings — the unsandboxed fallback is open`);
  else if (!holder) problems.push("sandbox.allowUnsandboxedCommands is not held false at user scope — set it to false in ~/.claude/settings.json (or by managed policy); until then a command can fall back to running unsandboxed, and a project setting cannot hold it closed");
  for (const s of sources) {
    const excluded = s.settings?.sandbox?.excludedCommands;
    if (excluded != null && !(Array.isArray(excluded) && excluded.length === 0)) {
      problems.push(`sandbox.excludedCommands is set in ${s.scope} settings (${s.path}): ${JSON.stringify(excluded)} run outside the sandbox — L3 needs it empty in every scope`);
    }
  }
  return { ok: problems.length === 0, enabled, enabledBy: enabled ? set.scope : null, heldBy: holder ? holder.scope : null, problems };
}

/** The L3 verdict: the bench verdict (l3Check) AND the sandbox posture — its problems follow the bench's. */
export function withSandbox(result, posture) {
  return { ...result, ok: result.ok && posture.ok, unmet: [...result.unmet, ...posture.problems], sandbox: posture };
}

/** One line for reports: where the sandbox is on and who holds the fallback closed (only for a posture that holds). */
export const postureSummary = (p) => `on (${p.enabledBy}); unsandboxed fallback held closed (${p.heldBy})`;
