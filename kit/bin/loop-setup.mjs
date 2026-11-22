#!/usr/bin/env node
// loop-setup — the kit's single command (composition root). Lifecycle subcommands (install,
// init, restore, sync, where, doctor, verify-kit, hook, …) are dispatched to kit/setup; every other
// subcommand is a TRACE-lite command (the former `pnpm trace …`) and runs kit/trace/cli.mjs.
// Both are imported lazily: the hooks run in every project and must stay cheap.
const [cmd, ...rest] = process.argv.slice(2);
const LIFECYCLE = new Set(["install", "uninstall", "init", "restore", "sync", "where", "doctor", "verify-kit", "hook"]);

if (LIFECYCLE.has(cmd)) {
  const { runLifecycle } = await import("../setup/commands.mjs");
  process.exitCode = await runLifecycle(cmd, rest);
} else {
  const { run } = await import("../trace/cli.mjs");
  await run(process.argv.slice(2));
}
