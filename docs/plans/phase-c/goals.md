# Phase C goals (loop-setup kit): specification

One section per goal. Each section is the full goal: task, context, pre-flight, success criteria,
constraints, checkpoints, self-verify and budget. Run them in order C1 → C7. The combined goal that
executes C3–C7 in one run (`goals-run.md`) refers to these sections verbatim.

## C1

```text
Goal: Upgrade Playwright so E2E runs on the cloud image's Chromium without the shim, and move CI's e2e job back to ubuntu-latest.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. @playwright/test (and @axe-core/playwright only if required) is pinned to the version whose Chromium build matches /opt/pw-browsers in this container: name both build numbers, read from each candidate's browsers.json. `pnpm test:e2e` passes 16/16 with no PLAYWRIGHT_BROWSERS_PATH shim.
2. The lockfile is regenerated with `CI=true corepack pnpm@10 install` (the pnpm gotcha in .claude/loop-workspace/topics/remote-env.md), and `pnpm install --frozen-lockfile` passes.
3. The e2e job in .github/workflows/verify.yml runs on ubuntu-latest again, with its pin comment removed. If that Playwright version does not support the runner OS, keep the pin and explain why.
4. The wiki facts about the pin and the shim in topics/remote-env.md (TR-1a2a7cac54bb, TR-e7829fbc9fc1) are revised through /dream: a new record that `revises` each, with this session's evidence.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope. No other dependency changes.
Checkpoints: run straight through; pause only if a check fails twice with the same error.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 10 turns if not achieved and report what is done and what blocks.
```

## C2

```text
Goal: Make reaudit resolve every evidence ref written before the kit moved: a file-level legacy map plus explicit handling of split files.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. A golden test lists every distinct path cited by file_line/diff evidence in kit/test/fixtures/legacy-v1/trace/records.jsonl and asserts each resolves to exactly one of: an unchanged path; a file-level LEGACY_REF_MAP entry generated from the kit move's renames (`git diff -M --name-status` of the move commit, e.g. ec6d24b); a workspace path; or an explicit split entry (CLAUDE.md -> kit/rules/KIT.md, topics/trace.md -> kit/rules/trace-policy.md, the loop-plan.md schema). Zero unmapped.
2. Absolute refs (/home/user/loop-setup/...) are normalized to repo-relative before mapping.
3. `loop-setup reaudit` over the fixture store, in a temp clone of this repo with full history, reports no "evidence changed" entry whose content did not change. A split file is reported once as "split at <commit> - re-verify", never as changed forever, and a REAUDIT action clears it.
4. The mapping is a pure function in kit/setup/layout.mjs with unit tests; git calls stay in adapters.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope.
Checkpoints: run straight through; pause only if a check fails twice with the same error.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 10 turns if not achieved and report what is done and what blocks.
```

## C3

```text
Goal: Move each workspace's git directory out of the workspace and refuse planted git config, so a write into the workspace can never run code at sync time.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. New and restored workspaces keep their GIT_DIR at ~/.claude/loop-setup/state/<id>.git, outside the per-project additionalDirectories grant; the workspace holds no .git. Existing workspaces migrate on their next sync or restore, keeping the same HEAD and history (tested on real git).
2. Every state git call passes an explicit --git-dir/--work-tree plus the existing HARDEN flags. It refuses (exit 2, naming the cause) when the work tree has a .gitattributes other than the kit template's content or any .gitmodules, or when the state repo's config sets filter.*, diff.*.textconv, merge.*.driver or any core.* hook setting. A test plants each and shows nothing ran (its marker file is absent).
3. sync, restore, syncStatus, the Stop hook and doctor behave unchanged for the user; kit/setup/lifecycle.test.mjs stays green.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope.
Checkpoints: before code, present the migration plan (layout, migration trigger, rollback, what doctor reports) and wait for approval; then run straight through.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 12 turns if not achieved and report what is done and what blocks.
```

## C4

```text
Goal: Make the record store tamper-evident: a per-writer hash chain on every new record and action, with checkpoints anchored outside the workspace.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. Schema trace-lite/1.1 is additive: 1.0 lines replay unchanged as an unchained prefix. It adds chain {w: writerId, prev: sha256 of that writer's previous line or null} and provenance.workspace. writerId is random per workspace and machine, stored outside the synced state. The writer fills both; `loop-setup lint` verifies every chain.
2. A two-clone test on real git (as in kit/setup/lifecycle.test.mjs): union merges and rebases of two writers keep lint green; editing or deleting a middle line turns it red.
3. The SessionStart hook verifies the existing prefix, then appends checkpoints {n, sha256 of line n} to ~/.claude/loop-setup/anchors/<id>.jsonl. lint and doctor check that every checkpoint is a prefix and the count never drops. A failed prefix check is reported in the injected context and never silently re-anchored.
4. The policy version in kit/rules/trace-policy.md is bumped, with its table and contract tests updated; every <trace-evidence-gate> copy stays in parity.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope.
Checkpoints: before code, present the design (what is hashed, where writerId lives, merge semantics, the policy bump) and wait for approval; then run straight through.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 15 turns if not achieved and report what is done and what blocks.
```

## C5

```text
Goal: Count a plan node as done for readiness only when its change has landed in the project's HEAD.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. When the loop CLEARs a node (kit/loop.md, loop-iteration result), it records its change's commit sha and patch-id, or whatever design is approved at the checkpoint.
2. readyIds, plan-items and plan-lint (kit/trace/plan.mjs) use a landed port: landed when the commit is an ancestor of HEAD, or a commit in HEAD's history has the same patch-id (covers squash); otherwise unknown. Only landed satisfies `after`; plan-lint reports [done-unlanded]; a human LAND action overrides. The decision is pure; git sits behind an adapter.
3. Tests on real git: merge, squash and cherry-pick count as landed; an unmerged branch does not; a later change near the hunk does not create a false negative (unlike git apply --reverse).
4. Done nodes recorded before this change, with no commit, count as landed with a warning, so existing plans behave the same.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope.
Checkpoints: before code, present the design (what CLEAR records, the landed table, the legacy rule) and wait for approval; then run straight through.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 12 turns if not achieved and report what is done and what blocks.
```

## C6

```text
Goal: Bring the docs up to the installed-kit model: redraw the five README infographics and document starting a new project from the template.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. docs/infographic-*.svg show the current model: install/init/sync/restore; the kit in ~/.claude plus the workspace on claude/loop-state; `loop-setup` commands, with no `pnpm trace` and no "copy these". Counts match kit/commands and kit/workflows. PNGs are regenerated from the SVGs with Playwright (deviceScaleFactor 2).
2. scripts/template-docs.test.mjs is green and extended to fail if an SVG says `pnpm trace` or "copy".
3. kit/docs/adoption-guide.md Path A covers a repo created from the template, with exact commands: either remove kit/ (plus the kit vitest include and kit-only CI steps) and install from upstream, or keep it as the kit source. The README quickstart links it.
4. A doc test asserts that every `loop-setup` subcommand in the CLI help appears in the adoption guide or the planning guide.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope. Docs only: no kit behaviour change.
Checkpoints: run straight through; pause only if a check fails twice with the same error.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 10 turns if not achieved and report what is done and what blocks.
```

## C7

```text
Goal: Close loop-setup phase C: record its status and open the PR.

Context: loop-setup phase C (state durability and upkeep), after phase B and goals 6-7 are merged. Background: docs/plans/home-workspace/analysis.md §5.10-5.11 and §8; implementation-plan.md "Status fazy B" open items. Kit source kit/ is denylisted, so this is Lead work via /multi-agent-dev, not /loop. Live kit ~/.claude/loop-setup/kit; state .claude/loop-workspace -> claude/loop-state.
Pre-flight (read-only, first): `loop-setup verify-kit` exits 0 and `loop-setup doctor` has no fail; otherwise stop and report.

Success criteria (all must hold):
1. docs/plans/home-workspace/implementation-plan.md gains a "Status fazy C" section in Polish, like the phase-B one: goals landed with their commits, evidence, and what stays open.
2. A closing /critic-round (code-only, completeness critic on) over `git diff main...HEAD` ends with completion accept, no open blocker and empty notRechecked. Fixes are re-checked by a separate round and CLEARed.
3. The full chain is green and `loop-setup sync` is done. A PR to main is open with the phase-C summary, and its CI is green. Do not merge: report the PR link and wait for the user.

Constraints: CLAUDE.md design principles (hexagonal first: decisions are pure functions over facts, git/fs via adapters; then SOLID, KISS, DRY; test-first). Never weaken or delete a test or assertion; state the root cause of any changed expectation. Keep the <loop-verifier> block byte-identical and every parity block in sync. Do not touch the environment setup script or the live ~/.claude settings by hand. Commit by pathspec at each green checkpoint and push to this session's branch only; no PR, no merge, no force-push. Nothing outside this goal's scope. The PR is the one exception to "no PR" in this goal; still no merge.
Checkpoints: pause if a critic blocker survives the fix-attempt bounds in CLAUDE.md; otherwise run straight through.
Self-verify: run the new tests first, then pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm test:e2e, then loop-setup lint, wiki-check, doctor and verify-kit; then a post-implementation /critic-round (code-only) ending with completion accept and no open blocker (fix confirmed blockers and goal-related important findings, re-check in a separate round, CLEAR; records written; loop-setup sync). Report each command with its exit status and summary line (never piped or truncated), the critic matrix, `git diff --stat main...HEAD` and the remaining risks.
Stop after 10 turns if not achieved and report what is done and what blocks.
```
