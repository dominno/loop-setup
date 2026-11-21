#!/usr/bin/env node
// loop-setup — the kit's single command (composition root). Lifecycle subcommands (install,
// init, restore, sync, where, doctor, hook, …) are dispatched to kit/setup; every other
// subcommand is a TRACE-lite command (the former `pnpm trace …`) and runs kit/trace/cli.mjs.
import { run as runTrace } from "../trace/cli.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const LIFECYCLE = new Set(["install", "uninstall", "init", "restore", "sync", "where", "doctor", "hook"]);

if (LIFECYCLE.has(cmd)) {
  const { runLifecycle } = await import("../setup/commands.mjs");
  process.exitCode = await runLifecycle(cmd, rest);
} else {
  await runTrace(process.argv.slice(2));
}
