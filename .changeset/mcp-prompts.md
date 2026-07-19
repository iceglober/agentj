---
"@glrs-dev/aj": minor
---

MCP server-provided prompt templates are now supported. Prompts are discovered with pagination at connect time (and lazily refreshed on prompt-list-change notifications), listed by `/mcp`, and invoked as namespaced slash commands like `/mcp:github:review-pr` with fuzzy completion — built-in commands always win. Arguments are collected interactively with required-field validation; the returned prompt messages (including embedded text resources) are bounded, labeled as untrusted external content, and submitted through the normal chat path, so the opaque model continuation and resumed sessions are unaffected.
