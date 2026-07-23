# MCP servers

Connects [MCP](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP. Servers connect in the background; a failed server does not block the others. Available to the primary agent only — subagents and jobs do not inherit MCP unless a server opts in.

## stdio server

`.glorious/config.json`:

```json
{
  "mcp": {
    "servers": {
      "github": {
        "transport": "stdio",
        "command": "github-mcp-server",
        "envFrom": { "GITHUB_TOKEN": "GITHUB_TOKEN" },
        "tools": { "plan": ["search_*", "get_*"], "build": ["*"], "direct": ["search_code"] },
        "resources": { "plan": ["docs*"], "build": ["*"] }
      }
    }
  }
}
```

`envFrom` maps a child-process variable to one in glorious's environment. Relative `cwd` resolves from the project root.

## Remote server

```sh
glorious config set mcp.servers.docs '{
  "transport":"http",
  "url":"https://mcp.example.com/mcp",
  "headersFromEnv":{"Authorization":"MCP_AUTH_HEADER"},
  "tools":{"build":["*"]}
}'
```

## Tool exposure

Patterns are exact names with an optional trailing `*`. `tools.plan` defaults to empty; `tools.build` defaults to all. `tools.direct` tools get native JSON schemas; the rest are reached via `find_mcp_tools` / `call_mcp_tool`. Resources use `find_mcp_resources` / `read_mcp_resource`, including URI templates.

## Prompts, auth, permissions

- Prompts appear as `/mcp:<server>:<prompt>`.
- `/mcp auth <server>` runs OAuth 2.1 (discovery, dynamic client registration, PKCE, localhost callback); tokens live in the OS keychain and refresh automatically. Falls back to a masked header prompt.
- Calls are gated by `permissions.mcp` under names like `mcp_github_search_code`.
- `/mcp` shows status; `/mcp reload [name]` reconnects. Changes apply on the next foreground turn.

## Inheritance

- HTTP: `inherit: "shared"` — children get a read-only view of the catalog.
- stdio: `inherit: "isolated"` — each child spawns its own process rooted at its worktree.

Children's calls ride `permissions.mcp`. Non-interactive contexts reuse saved tokens and never open a browser.
