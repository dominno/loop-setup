# Loop Run Log

Append-only history of `/loop` runs (the loop's durable **state**, separate from
the wiki's `log.md` which records `/dream` operations). Read this at the start of
every loop iteration; write an entry at the end. Newest entries at the bottom.

Entry format (see `.claude/loop.md`):

```
## [YYYY-MM-DD HH:MM] L<level> | <task>
- found: <n blockers / n important / n nice-to-have>
- actions: <fixes applied, or "report only">
- escalations: <none | reason>
- evidence: <tests/browser>
- next: <stop | continue | awaiting human>
```

Rules:
- One entry per loop iteration; record outcomes, timestamps, and any human override.
- Prune resolved watchlist items; keep the decision trail.
- **Rotation:** when this file passes **500 lines**, roll older entries into
  `.claude/memory/loop-run-log/<YYYY>.md` (same rule as `log.md`); the file is not
  `@imported`, so this is about read/append cost only.

---

_No loop runs recorded yet._
