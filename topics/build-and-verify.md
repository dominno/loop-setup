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
- `pnpm build` (Next 16.2.9) rewrites the tracked `next-env.d.ts` import from
  `./.next/dev/types/routes.d.ts`, the committed version, to `./.next/types/routes.d.ts`.
  Restore it with `git checkout -- next-env.d.ts` before committing. <!-- rec:TR-704c56b44868 -->

Related: [tooling](./tooling.md) · [testing](./testing.md) · [workflow](./workflow.md) · [quality-bar](./quality-bar.md)
