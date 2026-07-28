# Build & verify

- `pnpm verify` runs: typecheck → lint → unit → build → E2E. **`pnpm build` also runs the
  bundle-size gate** (`next build && scripts/check-bundle-size.mjs`) — so the perf budget
  defined in [quality-bar.md](./quality-bar.md) is enforced everywhere `build` runs,
  including **CI's `build` matrix job** (CI runs the per-script matrix + e2e, not `verify`,
  so attaching the check to `build` is what gets it enforced on PRs). `pnpm check:bundle`
  runs it standalone. Don't restate the KB number here.
- Next 16 **removed `next lint`**; `pnpm lint` runs `eslint .` directly.
- Use `eslint-config-next`'s **native flat config** in `eslint.config.mjs`
  (`import next from "eslint-config-next"`). Do **not** use `FlatCompat` — it
  crashes under ESLint 9 ("Converting circular structure to JSON").

Related: [tooling](./tooling.md) · [testing](./testing.md) · [workflow](./workflow.md) · [quality-bar](./quality-bar.md)
