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
- **Zero `serious` or `critical` axe violations** on the main flow (initial load, the
  validation-error state, and the greeting/remembered state) — in particular
  `color-contrast`, `label`, `aria-*`, and `region` rules.
- Interactive controls keep a visible focus indicator (already: `:focus-visible` styles).

## Performance target (client JS budget)
<!-- perf-budget-kb-gzip: 190 --> (machine-readable single source of truth; the enforcing
script `scripts/check-bundle-size.mjs` reads THIS marker — edit the number here, nowhere else.)
- **First-load client JS ≤ 190 KB gzipped.**
- **Metric (deterministic, CI-checkable without a browser):** sum of the **per-file**
  gzipped sizes of **all** `.next/static/chunks/**/*.js` after `next build` (exactly what
  `scripts/check-bundle-size.mjs` computes — per-file, not gzip-of-concatenation). For this
  **single-route** app that whole-directory total *is* the first-load set; if routes are
  added later, narrow the metric to the `/` route's chunks so "first-load" stays literal.
- **Baseline measured 2026-07-28:** 181.9 KB gzip (614.5 KB raw). The 190 KB budget is
  the baseline **+ ~4.5% headroom** — a ratchet, not aspirational: it passes today and
  catches an unintended dependency/bundle regression.
- Most of the bundle is the shared React/Next framework; the app's own code is a few KB.

## How the targets are enforced
- **a11y:** a Playwright + axe check over the main flow runs in `pnpm test:e2e` (part of
  `pnpm verify`). A `serious`/`critical` violation fails the suite.
- **perf:** a bundle-size assertion (sum the gzipped `.next/static/chunks/*.js`, compare
  to the budget) runs in `pnpm verify`.
- **critics:** the Accessibility and Performance lenses in `.claude/workflows/critic-panel.js`
  judge the current UI against these numbers, not vague "is it accessible / fast".

## Ratchet policy
When the bundle legitimately grows (a justified new dependency/feature), **raise the
budget consciously in this file** with a one-line reason — never silently, and never
lower a target just to make a failing check pass (fix the real violation instead).
