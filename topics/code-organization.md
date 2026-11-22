# Code organization

- Routes under `src/app`, API handlers under `src/app/api`, pure domain logic
  under `src/lib` (kept DOM-free and unit-tested), client components under
  `src/components`.
- The loop-setup kit's source lives in `kit/` (`bin/loop-setup.mjs`, `setup/`, `trace/`,
  `workflows/`, `commands/`, `rules/`, `templates/`); the app (`src/`, `e2e/`) does not import it,
  and `node kit/bin/loop-setup.mjs install --from .` copies the **committed** kit into
  `~/.claude/loop-setup/kit` (commands to `~/.claude/commands`, hooks to `~/.claude/settings.json`).
  <!-- rec:TR-87c615903b10 -->
- In the kit's source repo, the installed `loop-setup` shim's `denylist-check` uses the installed
  kit's verified copy of the denylist, while `node kit/trace/cli.mjs denylist-check` reads HEAD's
  `kit/workflows/loop-iteration.js`. A committed denylist change therefore reaches the shim only
  after the kit is reinstalled. <!-- rec:TR-69332a3f17e0 -->

Related: [client-react](./client-react.md)
