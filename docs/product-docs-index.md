# Product Docs Index

Lists the source documents the Product Delivery Auditor scanned and their purpose.
Update this file whenever new PRDs, specs, README files, or planning docs are found.

| Document | Type | Purpose | Last scanned |
|---|---|---|---|
| `docs/prd.md` | PRD | Product requirements: greeting (5.1) and remember-me (5.2) | 2026-06-27 |
| `README.md` | README | Setup overview, workflow commands, starter-app description | 2026-06-27 |
| `CLAUDE.md` | Project rules | Verification commands, multi-agent workflow, completion gates | 2026-06-27 |

## How to use

- Run `/scan-project-docs full project` to populate this index.
- Each scanned document should be listed with its type (PRD, spec, README, ADR, ticket, route/API doc) and what product area it covers.
- Keep this index in sync with the actual files in the repository.

> Note: `docs/prd.md` is the source of record for user stories. US-001 (greeting)
> is implemented; US-002 (remember me on return) is documented but not yet built.
