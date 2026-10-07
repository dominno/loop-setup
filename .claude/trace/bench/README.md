# TRACE-Bench-lite fixtures

`fixtures.bundle` holds the bench's seeded-defect ("bad") and correct ("good") diffs
against the starter app, **gzip+base64-encoded on purpose**: the bench agents run inside
this repo and grep it freely, so any ground truth readable as plain text (fixture ids,
defect descriptions, the patches themselves) contaminates the measurement. The first
bench run proved it — agents found and read a plain-text manifest.

Rules (enforced by `scripts/trace/contracts.test.mjs`):
- No fixture id or defect text may appear as plain text anywhere in the tree.
- Agents receive opaque tokens (`fx-xxxxxxxx`) — never the real ids.
- Raw bench runs are **not** committed (their verdict prose names the defects); only the
  scored, counts-only TRACE record is.
- `pnpm trace bench-score --transcripts <dir>` scans every agent transcript for leaked
  ground truth and excludes those runs (flag F0).

Editing fixtures: `pnpm trace bench-unpack <dir-outside-the-repo>` → edit
`<dir>/fixtures.json` (patches are inline; generate each with `git diff` from a clean
tree) → `pnpm trace bench-pack <dir>` → `pnpm test` (bundle valid, patches apply, judge
kinds match the denylist, no leaks) → `pnpm trace bench-judge` (judge claims observed).

How to run and read the bench: `/bench-checkers` · policy: `.claude/memory/topics/trace.md`.
