# User Stories — index

Catalog of user stories extracted from the product documentation. **Each story is
its own file** under [`docs/stories/`](./stories/) (`US-NNN-<slug>.md`) so the
backlog scales to a large project without one giant file. This page is the index;
[`docs/implementation-status.md`](./implementation-status.md) is the evidence
dashboard. Populate/refresh with `/scan-project-docs` and `/sync-story-status`.

> **Why per-file:** `docs/` is not loaded into context automatically, but a single
> monolithic stories file truncates on read (~2000 lines), is awkward to edit per
> story, and conflicts under parallel work. One file per story keeps each record
> small and independently editable. Mirrors the memory wiki's index + pages shape.

## Stories
| ID | Title | Source | Status | File |
|---|---|---|---|---|
| US-001 | Greet a visitor by name | `docs/prd.md#51` | E2E tested | [stories/US-001-greeting.md](./stories/US-001-greeting.md) |
| US-002 | Remember me on return | `docs/prd.md#52` | E2E tested | [stories/US-002-remember-me.md](./stories/US-002-remember-me.md) |

## Adding a story
1. Copy [`stories/_TEMPLATE.md`](./stories/_TEMPLATE.md) to
   `stories/US-NNN-<slug>.md` and fill it in (one verifiable record per file).
2. Add a row to the table above and to `docs/implementation-status.md`.
3. Keep status **evidence-based** — see the status model in
   `docs/implementation-status.md`; a story is `Done` only with implementation +
   passing tests + E2E/browser verification recorded in
   `docs/story-verification-log.md`.

The full per-story record format lives in [`stories/_TEMPLATE.md`](./stories/_TEMPLATE.md).
