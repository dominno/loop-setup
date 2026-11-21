# Code organization

- Routes under `src/app`, API handlers under `src/app/api`, pure domain logic
  under `src/lib` (kept DOM-free and unit-tested), client components under
  `src/components`.
- The loop-setup kit's source lives in `kit/` (`bin/loop-setup.mjs`, `setup/`, `trace/`,
  `workflows/`, `commands/`, `rules/`, `templates/`); the app (`src/`, `e2e/`) does not import it,
  and `node kit/bin/loop-setup.mjs install --from .` copies the **committed** kit into
  `~/.claude/loop-setup/kit` (commands to `~/.claude/commands`, hooks to `~/.claude/settings.json`).
  <!-- rec:TR-87c615903b10 -->

Related: [client-react](./client-react.md)
