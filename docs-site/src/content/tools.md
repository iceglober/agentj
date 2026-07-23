# Tools

5 custom tools registered by the [harness plugin](/harness). These extend OpenCode's built-in tool set — [agents](/harness/agents) call them automatically during execution.

## ast_grep

Structural code search via [ast-grep](https://ast-grep.github.io/). Finds patterns by AST structure rather than text matching. More precise than grep for queries like "find all functions that call `db.query` without error handling."

Requires `ast-grep` (or `sg`) on PATH.

## tsc_check

Runs `tsc --noEmit` against the project and returns structured diagnostics. Used by the [tool-hooks sub-plugin](/harness) to verify edits didn't introduce type errors — every file edit triggers an automatic typecheck.

Requires `tsc` (TypeScript) in the project.

## eslint_check

Runs `eslint --format json` and returns structured lint results. Like `tsc_check`, runs automatically after edits via tool-hooks.

Requires `eslint` configured in the project.

## todo_scan

Scans files for `TODO`, `FIXME`, `HACK`, and `XXX` comments. Returns structured results with file, line, and comment text. Used by [agents](/harness/agents) during the assess phase to flag unfinished work before shipping.

## comment_check

Analyzes comment density and quality in changed files. Flags files with excessive comments, commented-out code, or comments that restate the obvious. Used during [code review](/harness/commands).
