# Build & verify

- `pnpm verify` runs: typecheck → lint → unit → build → E2E.
- Next 16 **removed `next lint`**; `pnpm lint` runs `eslint .` directly.
- Use `eslint-config-next`'s **native flat config** in `eslint.config.mjs`
  (`import next from "eslint-config-next"`). Do **not** use `FlatCompat` — it
  crashes under ESLint 9 ("Converting circular structure to JSON").

Related: [tooling](./tooling.md) · [testing](./testing.md)
