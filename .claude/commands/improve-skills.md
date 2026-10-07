---
description: Meta-critic pass over the project's OWN prompts, skills, and workflow orchestration — fan out one reviewer per quality lens, adversarially verify each finding, and PROPOSE edits to the core prompts. Never auto-applies; every change is confirmation-gated. Use periodically to let the system improve its own machinery, not just its facts.
argument-hint: [scope, e.g. "the loop workflows" | "all commands"]
disable-model-invocation: true
---

Run a **self-improvement pass over the system itself** — the custom prompts, skills,
and multi-agent orchestration that drive this project — not over product code. This
is the counterpart to `/dream`: `/dream` improves what the system *knows* (the wiki);
`/improve-skills` improves the *machinery that does the work* (the command and
workflow prompts), by dogfooding the same critic-panel pattern on our own config.

Scope:
$ARGUMENTS

## Procedure
1. **Run the meta-critic as a deterministic Workflow** — invoke the Workflow tool with
   `scriptPath: .claude/workflows/improve-skills.js`,
   `args: { "scope": "$ARGUMENTS" }` (optionally pass `args.targets` = a specific list
   of files to scope the review). One reviewer per quality lens (clarity,
   instruction-following risk, safety/gating, consistency/DRY, workflow DSL, routing)
   runs in its own context, in parallel; a *separate* skeptic adversarially verifies
   every blocker/important finding. Invoking Workflow here is expected.
2. The workflow returns `{ scope, targets, budgetStop, counts, applyReady, needsDesign, deferred, niceToHaves, refuted, traceRecords }`.
   Each finding carries a typed TRACE verdict derived from the two axes:
   `applyReady` = `accept` (real + edit safe), `needsDesign` = `revise` (real, edit not
   safe — its `repair` is a safer edit to design from), `deferred` = `defer` (no verdict
   or verification skipped — UNVERIFIED), `refuted` = `reject`.
   Render `applyReady` and `needsDesign` as a matrix and list `niceToHaves` separately:

   | Lens | Severity | File | Finding | Evidence | Proposed edit | Edit verified safe? |
   |---|---|---|---|---|---|---|

   List `deferred` separately with its `missing`.

   **If `budgetStop` is true**, tell the user up front that the adversarial verify phase
   was skipped due to the token-budget floor: every blocker/important finding is in
   `deferred` and **UNVERIFIED** (neither its reality nor its edit-safety was checked),
   `applyReady` and `needsDesign` are empty by design, and a follow-up `/improve-skills`
   pass should re-run verification before anything is applied.

3. **Confirmation gate (hard rule).** This command may propose edits to core prompts
   but must **never apply them without explicit confirmation** — the same rule
   `/dream` follows for creating/rewriting skills. Present the proposed edits and ask
   before touching any file.
4. After confirmation, apply only the approved `applyReady` edits (the ones whose
   `editSafe` is true). Treat `needsDesign` findings (real problem, edit not verified
   safe) as items needing a human-designed fix — surface them, don't auto-apply.
5. Do **not** weaken an instruction, remove a safety/confirmation gate, or delete a
   command/skill as part of an "improvement". Removing or rewriting an existing rule
   needs explicit confirmation; additive clarifications are lower-risk but still shown
   before applying.
6. When an edit changes a command or workflow, keep `.claude/skills-index.md` and any
   affected memory wiki page in sync (additive index updates need no confirmation).
7. **Record the outcome:** append the run's `traceRecords` (`pnpm trace write -`),
   then one consumer action per adjudicated finding — `CLEAR` for an edit you applied
   after confirmation, `REJECT` for one the user declined or you did not apply (with a
   note why). `CLEAR` is refused on anything but `accept` (fail closed).
8. End the task with `/dream` so any durable lesson from this pass is filed into the
   wiki.

## Notes
- Heavier, deterministic path: the workflow spawns ~6 meta-critics + one verifier per
  blocker/important finding. That is intended — independent review of our own prompts,
  not one context grading its own instructions.
- The verifier judges two things: is the problem **real**, and is the proposed edit
  **safe** (would it weaken instruction-following or a safety gate, or break a
  workflow?). Only real-and-safe findings are `applyReady`.
- `disable-model-invocation: true`: this command changes core prompts, so it is
  manual-only — never auto-invoked from a description match.
