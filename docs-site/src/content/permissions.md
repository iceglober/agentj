# Permissions

Tools execute in your checkout (host-first), gated at the tool layer by a **default-deny access-control list**: a request that no rule allows is denied.

## Never gated

- Repo read and search.
- Plan mode (no mutating tools).

## The ACL

Rules map a tool-call **pattern** to `allow`, `ask`, or `deny`. Set them with idempotent verbs:

```sh
glorious config allow "bash(git *)"        # a bash command, prefix-matched
glorious config allow edit                 # file edits
glorious config allow web                  # search + fetch
glorious config ask   "bash(*)"            # everything else bash → prompt
glorious config deny  "bash(rm -rf *)"     # always refuse
glorious config allow mcp_linear_get_issue # a canonical MCP tool
glorious config allow "mcp_github_*"       # a whole MCP server
glorious config unrule "bash(git *)"       # remove a rule
```

Patterns are the tool-call forms themselves — no separate expression language:

| pattern | matches |
|---|---|
| `bash(git *)` · `bash(*)` | a bash command, prefix-matched (trailing `*`); `bash` alone = all |
| `edit` · `edit(src/*)` | file edits, optionally by path prefix |
| `web` | outbound search and fetch |
| `mcp_linear_get_issue` · `mcp_linear_*` | a canonical MCP tool id, or a server (the `mcp__…` form is accepted too) |

**Resolution** is order-independent: for a request, a matching `deny` wins, then `allow`, then `ask`, and anything unmatched is denied.

The shipped starter policy allows edits and web, asks before unlisted shell commands (allowing `git`/`bun`/`pnpm`/`npm`, denying `rm -rf`), and asks before MCP calls — all overridable per project or machine.

## Uncaged

One switch opens everything:

```sh
glorious config uncaged on    # allow every gated tool call
glorious config uncaged off   # restore the rules
```

## Asks

The full terminal-escaped command prints before the controls:

```
[y]es once · [a]lways this session · [n]o
```

Concurrent asks queue. "Always" applies to `ask` outcomes only; a `deny` always holds. A denial returns to the model as a tool result.

## Non-interactive

`glorious run` resolves asks to deny unless `--allow-all` is passed. Denies still hold.

## Undo

File changes are snapshotted to a git ref namespace. `/undo` and `/redo` move through them without touching HEAD, index, or branch.
