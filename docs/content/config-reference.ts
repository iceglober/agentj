/**
 * The user-facing configuration keys documented on the site, in display order.
 * Keys and their defaults come from the live schema at generate time; only the
 * editorial description lives here. Every `path` is validated against
 * `listConfigPaths()` when the docs are built, so a renamed or removed key
 * fails the build instead of shipping a stale doc.
 */
export interface ConfigDoc {
  path: string;
  description: string;
}

export const CONFIG_DOCS: readonly ConfigDoc[] = [
  { path: "agent.llm.model", description: "The primary model id the agent runs on." },
  { path: "agent.llm.provider", description: "Model provider. Azure AI Foundry is wired in." },
  {
    path: "agent.llm.tiers",
    description:
      "Ordered model ladder. Modes and subagents route to a tier index instead of a raw model id, so swapping the ladder never touches routing config.",
  },
  {
    path: "agent.llm.modes.plan",
    description: "Ladder tier plan mode runs on. Defaults to the frontier tier (0).",
  },
  { path: "agent.llm.modes.build", description: "Ladder tier build mode runs on." },
  {
    path: "agent.tools.subagents.tier",
    description:
      "Ladder tier subagents and planning workers run on — route fan-out to a cheaper rung.",
  },
  {
    path: "agent.tools.subagents.model",
    description:
      "Explicit model for subagents (deprecated — prefer `tier`; wins over it when set).",
  },
  {
    path: "agent.tools.subagents.concurrency",
    description: "Maximum subagents run at once within a single fan-out.",
  },
  {
    path: "agent.tools.edit.mode",
    description: "Edit-tool strategy: `exact`, `batch`, or `hash`.",
  },
  {
    path: "agent.tools.maxOutputChars",
    description:
      "Character cap on tool output returned to the model. Over-cap output spills to a session file so nothing is lost.",
  },
  {
    path: "agent.context.softLimit",
    description: "Request input-token threshold that triggers `onLimit`. Unset means no ceiling.",
  },
  {
    path: "agent.context.onLimit",
    description:
      "Behavior when a request crosses the soft limit: `warn` or `compact` (summarize history).",
  },
  {
    path: "agent.steps",
    description:
      "Per-turn tool-loop ceiling (model round-trips) — runaway protection, not a work budget.",
  },
  {
    path: "permissions.edit",
    description: "Policy for file edits in build mode: `allow`, `ask`, or `deny`.",
  },
  {
    path: "permissions.bash.default",
    description: "Default policy for bash commands, before the allow/deny lists.",
  },
  {
    path: "permissions.bash.allow",
    description: "Command prefixes (optional trailing `*`) that skip the prompt.",
  },
  {
    path: "permissions.bash.deny",
    description: "Command prefixes that are always refused; checked before allow.",
  },
  {
    path: "permissions.mcp.default",
    description: "Default policy for MCP tool calls, before the allow/deny lists.",
  },
];
