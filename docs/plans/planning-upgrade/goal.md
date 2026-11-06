/goal Implement 100% of the planning & task-status upgrade in docs/plans/planning-upgrade/04-spec.md (W0–W5, incl. multi-developer M1–M10) on a new branch from main, and ship it as one PR.

Read first: 04-spec.md (scope, rules, done), 02-council-findings.md (each item's skeptic repair/qualifier is BINDING: build the adjudicated version, not the critic's first draft), 03-multi-developer.md (M1–M10), 01-research.md (background). CLAUDE.md, .claude/loop.md and .claude/memory/loop-plan.md govern.

Success criteria (all must hold):
1. Every W0–W5 item is implemented, or the PR names the binding qualifier that limits it. A checklist in docs/plans/planning-upgrade/steps.md (id, description, scope, check, after, status, commit) shows each item done with its commit.
2. Each new rule has a test written first and seen failing; `pnpm test` reports 0 failed and 0 skipped; `pnpm verify` exits 0; `pnpm trace lint`, `plan-lint`, `story-lint` and `wiki-check` exit 0.
3. Back-compat holds: today's loop-plan.md, legacy LP-NNN ids and existing records stay valid (a test proves it); the plan-items item shape and <loop-verifier> are unchanged, or the PR states that /bench-checkers must be re-run before L3.
4. A post-implementation critic round (/critic-round, code-only) has completion accept with no open blocker, its records are written, and important findings are fixed or answered.
5. /dream has ingested the durable facts (admission records, wiki-check clean), and the PR is open with a merge-commit note.

Constraints:
- Extend the markdown DAG and TRACE discipline. No JSON plan, no epic/parent containers, no numeric complexity score, no new node status: W3 split uses `dropped` + `split from`.
- Never weaken or delete an assertion or a gate; never hand-edit records.jsonl; never edit <loop-verifier>; never run /bench-checkers unasked.
- Commit by pathspec, one commit per item; never rewrite pushed history; no unrelated refactors; app code (src/, e2e/) untouched.
- Keep .claude/memory/topics/trace.md ≤ 400 lines and topic pages ≤ 200 lines.
- New commands get a skills-index row and follow the manual-only rule; docs describing a changed rule change in the same commit.

Checkpoints:
- Pause and ask before: changing the plan-items item shape or anything the loop verifier sees; any change to .claude/settings.json or CI config; and if a binding qualifier conflicts with the spec.
- Otherwise run straight through W0→W5 in order. Report after each workstream in one short paragraph: done items, commits, tests.

Self-verify before claiming done: re-run the gates in criterion 2 and observe them in full (no pipes); run the critic round as the separate checker (the implementer never marks its own work done); confirm each steps.md row against `git log`; then report in the CLAUDE.md final format with evidence.

Budget: stop after 120 turns, or if one check fails with the same error 5 times. If so, report the blocker (command, error, attempts, root-cause hypothesis) and leave the task incomplete.
