# Quality bar — objective a11y & performance targets

Concrete, measurable targets the **Accessibility** and **Performance** critics judge
against — the "external bar" idea (a bar the agent can't talk its way around) applied to
the two lenses that otherwise rely on unanchored checklist language. Functional work
already has a hard bar (`docs/prd.md` acceptance criteria + `pnpm verify`); this extends
the same discipline to a11y and perf. These are also wired as **gates** (see below), not
just critic opinion.

> Scope: a11y + performance **only**. There is deliberately **no** aesthetic /
> reference-exemplar bar for the Designer or Artistic Direction critics — for this
> minimal app that would be over-engineering; those lenses stay qualitative.

## Accessibility target (WCAG 2.1 AA)
- **Text contrast ≥ 4.5:1** for normal text, **≥ 3:1** for large text (≥ 24px, or ≥ 18.66px
  bold). Disabled/inactive controls are exempt per WCAG 1.4.3. Placeholder text is **not**
  blanket-exempt: when it conveys information it should meet the same targets, and it must
  never be a field's only label. (Our fields carry a persistent visible `<label>`, so an
  example-format placeholder is supplementary — a sub-4.5:1 hint is acceptable *only*
  because that visible label exists.)
- **Zero `serious` or `critical` axe violations** (WCAG 2.1 A/AA) on the main flow (initial
  load, the validation-error state, and the greeting/remembered state) — in particular
  `color-contrast`, `label`, and `aria-*` rules.
- **Landmark structure:** zero `region` / `landmark-one-main` violations. These are axe
  *best-practice* rules (not in the WCAG-AA tag set and often below serious/critical), so
  the gate checks them **explicitly** (a separate `withRules` scan), not via the tag filter.
- **Keyboard-operable happy path:** the flow is completable with the keyboard alone (Tab to
  the field, type, Tab to the submit button, Enter → greeting) — smoke-tested in the a11y
  spec. Interactive controls keep a visible focus indicator (`:focus-visible` styles).
- **Not covered by this gate** (stays with the qualitative Designer / Artistic lenses):
  mobile-viewport layout and tap-target sizing (`target-size` is WCAG 2.2 AA, outside this
  desktop WCAG-2.1-AA scan). Don't read "zero violations" as a mobile/touch guarantee.

## Performance target (client JS budget)
<!-- perf-budget-kb-gzip: 155 --> (machine-readable single source of truth; the enforcing
script `scripts/check-bundle-size.mjs` reads THIS marker — edit the number here, nowhere else.)
- **First-load client JS ≤ 155 KB gzipped.**
- **Metric (deterministic, CI-checkable without a browser):** sum of the **per-file**
  gzipped sizes of `.next/static/chunks/**/*.js` after `next build`, **excluding the legacy
  noModule polyfill chunk(s)** (read from `.next/build-manifest.json` `polyfillFiles`) that
  modern module-supporting browsers never download — so the number is the JS a modern
  browser actually loads. Per-file gzip, not gzip-of-concatenation. For this **single-route**
  app the total *is* the first-load set; if routes are added, narrow it to the `/` route's
  chunks so "first-load" stays literal.
- **Baseline measured 2026-07-28:** 143.2 KB gzip (polyfill excluded). The 155 KB budget is
  the baseline **+ ~8% headroom** — a ratchet, not aspirational: it passes today and catches
  an unintended dependency/bundle regression.
- Most of the bundle is the shared React/Next framework; the app's own code is a few KB.

## How the targets are enforced
- **a11y:** `e2e/a11y.spec.ts` (Playwright + axe) covers the main flow's three states, an
  explicit landmark scan, and a keyboard-path test. It runs in `pnpm test:e2e`, which is
  part of `pnpm verify` **and** the CI `e2e` job — so a11y is enforced on every PR.
- **perf:** `scripts/check-bundle-size.mjs` runs as part of **`pnpm build`**
  (`next build && node scripts/check-bundle-size.mjs`). Because CI runs the per-script
  matrix (incl. `build`) + `e2e` rather than `pnpm verify`, attaching the check to `build`
  is what enforces the budget on **every PR** (the CI `build` job fails if it's over).
  `pnpm check:bundle` runs it standalone against an existing `.next`.
- **critics:** the Accessibility and Performance lenses in `.claude/workflows/critic-panel.js`
  judge the current UI against these numbers, not vague "is it accessible / fast".

## Ratchet policy
When the bundle legitimately grows (a justified new dependency/feature), **raise the
budget consciously in this file** with a one-line reason — never silently, and never
lower a target just to make a failing check pass (fix the real violation instead).
