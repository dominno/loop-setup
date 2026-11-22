// Lifecycle-write guard — the PURE core that decides whether `loop-setup install` / `uninstall` may
// write a Claude home. From inside Claude Code (CLAUDECODE is set in every Bash it runs) they refuse
// the session's own home: installing or removing the kit, its hooks and its settings is a human's
// step (a terminal outside Claude Code, or the environment's setup script at the next fresh
// container), never an agent's. A different home (a scratch CLAUDE_CONFIG_DIR, as the tests use)
// stays writable. The caller resolves both homes (realpath) so an alias or a ../ spelling cannot
// slip past. A policy guard, paired with owned deny rules; the sandbox is the boundary.

/** → null when the write may go on, else the refusal message. Homes are passed resolved. */
export function lifecycleRefusal({ cmd, claudecode, targetHome, sessionHome }) {
  if (!claudecode || targetHome !== sessionHome) return null;
  return `loop-setup ${cmd} refused: it would write this session's Claude home (${targetHome}) from inside Claude Code (CLAUDECODE is set) — installing or removing the kit is a human's step: run it in a terminal outside Claude Code, or let the environment's setup script do it at the next fresh container`;
}
