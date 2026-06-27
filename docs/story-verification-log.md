# Story Verification Log

Evidence log of checks that were actually run. Only record checks Claude truly
performed — command output, test runs, and browser observations. This log is the
required evidence trail before any story can be marked `Done`.

| Date | Story ID | Check performed | Command / action | Result | Notes |
|---|---|---|---|---|---|
| _none yet_ | — | — | — | — | — |

## What counts as evidence

- A test command and its pass/fail output (e.g. `pnpm test:e2e auth` passed).
- A browser observation on localhost (URL, flow tested, console state, network state).
- A typecheck/lint/build result tied to the story.

Do not log assumptions or "looks okay". Log only verifiable checks.
