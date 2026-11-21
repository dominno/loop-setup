# Client components (React 19)

- ESLint (`react-hooks/set-state-in-effect`, on via `eslint-config-next`) errors
  on synchronous `setState` inside `useEffect`. To restore state from
  `localStorage`/an external store, use `useSyncExternalStore` with a `null`
  server snapshot — not `useEffect` + `setState`.
- `localStorage` writes do **not** fire the native `storage` event in the same
  tab (only other tabs). Dispatch a custom `window` event after writing so
  same-tab `useSyncExternalStore` subscribers re-read.
- Browser-API wrappers (e.g. `localStorage`) live in their own `src/lib` module,
  SSR-guarded (`typeof window`/`globalThis` checks); the pure domain rule
  (`greeting.ts`) stays DOM-free.

Related: [testing](./testing.md) · [code-organization](./code-organization.md)
