---
"@glrs-dev/aj": patch
---

Power the `grep` and `glob` tools with ripgrep.

Both search tools now run the bundled ripgrep binary (`@vscode/ripgrep`, no host PATH dependency) instead of system `grep` and bash globbing — much faster on large repos, and `.gitignore`-aware so results skip `node_modules`, build output, and other ignored/hidden files by default. `.git` is always excluded. A new `includeIgnored` option on both tools searches git-ignored and hidden files when you need them. Output shapes are unchanged: `grep` returns `path:line:content`, `glob` lists files newest-first.
