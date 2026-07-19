---
name: ship
description: Ship completed engineering work in this repo — validate, add a changeset, open a pull request, and merge once CI is green. Use when code changes are complete and validated and the user wants them merged, or when the user says ship, open a PR, or merge this.
compatibility: Requires git and the gh CLI authenticated against github.com
metadata:
  agentj-mode: build
---

# Shipping work in agentj

Work is shipped when it is merged to `main` — not when the code is written.
Follow every step; do not skip the review loop.

## 1. Branch and validate

- Never commit to `main`. If work sits on `main`, move it to a branch created
  from the latest `origin/main` first.
- All of these must pass locally before a PR is opened (fix failures first):
  - `bun test core`
  - `bunx tsc --noEmit`
  - `bun run check`
  - `bun run eval -- --dry-run` when `core/eval/` or agent behavior changed

## 2. Changeset

- Every user-visible change needs a `.changeset/<slug>.md`:

  ```markdown
  ---
  "@glrs-dev/aj": minor
  ---

  One paragraph: what changed, from the user's point of view, with a concrete example.
  ```

- `patch` for fixes, `minor` for features. Internal-only refactors need no changeset.

## 3. Open the PR

- Commit with a conventional title (`feat(scope): …`, `fix(scope): …`), push
  the branch, then: `gh pr create --fill` (expand the body with motivation and
  testing notes when the diff is not self-explanatory).

## 4. Merge

- Confirm CI is green: `gh pr checks <n> --watch`
- If any review comments landed on the PR, address each one before merging:
  fix it and push, or reply on the thread with a short reason why not.
- Merge (auto-merge queues it if checks are still running):
  `gh pr merge <n> --squash --auto`
- After the merge, report the PR number and what shipped in one sentence.
