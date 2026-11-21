# Memory Log

Append-only record of wiki operations. Newest entries at the bottom. Prefixes:
`ingest` (new learnings filed), `lint` (health-check), `migrate` (structure
change), `rotate` (archived old entries). Format: `## [YYYY-MM-DD] <op> | <summary>`.

> **Rotation:** when this file passes **500 lines**, `/dream lint` moves the older
> entries into yearly archives at `log/<YYYY>.md` (created on demand)
> and leaves the recent entries here, then logs a `rotate` entry. Archives are read
> only when deep history is needed. This file is never `@imported`, so its size
> costs nothing per session — rotation is purely to keep reads/appends cheap.

