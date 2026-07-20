---
name: release
description: Merge the open Changesets Version Packages PR and report the released package versions and changelog. Use when the user asks to release packages, merge the Version Packages PR, or publish a prepared release.
compatibility: Requires git and the gh CLI authenticated against github.com
metadata:
  agentj-mode: build
---

# Release packages in agentj

The release workflow creates the version and publish PR. This skill only finds
and merges that PR; do not version or publish packages by hand.

## 1. Find the release PR

List open PRs against `main` and select only a PR that meets all of these
conditions:

- head branch is `changeset-release/main`
- title is exactly `Version Packages` or starts with `Version Packages (`
- base branch is `main`

For example:

```sh
gh pr list --state open --base main --json number,title,url,headRefName,isDraft,mergeStateStatus,headRefOid,statusCheckRollup,body
```

- If no PR matches, reply: `No open Version Packages PR found—nothing to release.`
  Do not make any changes.
- If more than one PR matches, stop and report the matching PR URLs. Do not
  choose one.
- If the match is a draft, has a merge state other than `CLEAN`, or has failing
  or pending checks, stop and explain what blocks the merge. An empty check
  rollup is valid.

## 2. Merge the exact PR revision

Record the matching PR number and `headRefOid`. Re-read the PR immediately
before merging and confirm that its head SHA is unchanged. Then squash merge
that exact revision:

```sh
gh pr merge <number> --squash --match-head-commit <head-sha>
```

If GitHub rejects the merge, report the error and do not retry with a different
strategy. After a successful command, verify the PR state is `MERGED`:

```sh
gh pr view <number> --json state,mergedAt,url,title,body
```

## 3. Report the release

After verification, report:

- the merged PR URL and title
- every package name and version in the PR body's `# Releases` section
- the generated changelog entries from that section

Keep the changelog text faithful to the PR body. If the merged PR has no
`# Releases` section, say so and include the PR URL and title; do not invent
versions or changelog text.
