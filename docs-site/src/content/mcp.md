# MCP servers

Glorious connects [Model Context Protocol](https://modelcontextprotocol.io) servers over **stdio** or **Streamable HTTP**, exposing their tools, resources, and prompts to the agent. Startup never blocks on MCP — servers connect in the background, and one failed server can't stall the session or the others. MCP is available to the **primary agent only**; subagents and jobs don't inherit it unless a server opts in.

## A stdio server

In `.glorious/config.json`:

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

`envFrom` maps a child-process variable to one in glorious's environment, so secrets never land in config. Relative `cwd` resolves from the project root.

## A remote server

```sh
glorious config set mcp.servers.docs '{
  "transport":"http",
  "url":"https://mcp.example.com/mcp",
  "headersFromEnv":{"Authorization":"MCP_AUTH_HEADER"},
  "tools":{"build":["*"]}
}'
```

## Tool exposure

Patterns are exact names with an optional trailing `*`. Plan lists default to empty — adding a tool to `tools.plan` explicitly certifies it read-only-safe; build lists default to all. Tools in `tools.direct` get their native JSON schemas; everything else lives in a bounded catalog reached via `find_mcp_tools` / `call_mcp_tool`, so the model never sees every schema at once. Resources work the same way with `find_mcp_resources` / `read_mcp_resource`, including URI templates.

## Prompts, auth, permissions

- Server prompts appear as `/mcp:<server>:<prompt>` (e.g. `/mcp:github:review-pr`). Arguments are collected in terminal prompts; returned content is bounded and labeled untrusted.
- `/mcp auth <server>` runs the OAuth 2.1 flow — metadata discovery, dynamic client registration, PKCE, and a localhost browser callback. Tokens live in the OS keychain and refresh automatically. When OAuth isn't supported it falls back to a masked header prompt.
- Calls are gated by `permissions.mcp` under canonical names like `mcp_github_search_code`.
- `/mcp` inspects status; `/mcp reload [name]` reconnects one or all servers. Changes activate on the next foreground turn.

## Inheritance

HTTP servers may declare `inherit: "shared"` (children get a read-only view of the primary's catalog — call, never reload) and stdio servers `inherit: "isolated"` (each child spawns its own process rooted at its worktree, closed when the child finishes). Children's calls ride the same `permissions.mcp` policy. Non-interactive contexts never open a browser: authorize once interactively, then saved tokens are reused and refreshed.
