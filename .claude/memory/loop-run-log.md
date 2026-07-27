# Loop Run Log

Append-only history of `/loop` runs (the loop's durable **state**, separate from
the wiki's `log.md` which records `/dream` operations). Read this at the start of
every loop iteration; write an entry at the end. Newest entries at the bottom.

Entry format (see `.claude/loop.md`):

```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- node: <plan-item id acted on, or "none — report-only / no ready node">
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- re-plan: <nodes added / marked done / dropped, or "none">
- budget: <used>/<cap> (turns or tokens)
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Rules:
- One entry per loop iteration; record outcomes, timestamps, and any human override.
- The **plan** (`.claude/memory/loop-plan.md`) holds the *current* watchlist/DAG (mutable,
  re-planned each iteration); this run-log is the *append-only history*. Prune resolved
  nodes in the plan, not here; keep the decision trail in both.
- **Rotation:** when this file passes **500 lines**, roll older entries into
  `.claude/memory/loop-run-log/<YYYY>.md` — **create that directory/file on demand**
  if absent (same rule as `log.md`); the file is not `@imported`, so this is about
  read/append cost only.

---

_No loop runs recorded yet._
