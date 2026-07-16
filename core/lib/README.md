# core/lib — architecture

Package-by-domain, layer-by-file. Each folder is one domain; the layer of a
file is encoded by its name, not by a `ports/` / `adapters/` tree, so adding a
provider touches exactly one folder.

## The three kinds of module

1. **Ports** — boundaries to external systems. `index.ts` in the domain folder:
   the interface, its zod config schema, and a registry keyed by config value.
   The main two are `sandbox/` (command execution + file IO in an isolated
   environment) and `llm/` (the model *and* its generation loop — one boundary,
   the `AgentRuntime` interface; keyed by `llm.runtime`). `tools/bash/` is a
   thin port too: it quarantines the `bash-tool` vendor package behind a
   vendor-free `ToolSet`.
2. **Adapters** — `*-adapter.ts` next to their port, one per external SDK:
   `sandbox/microsandbox-adapter.ts`, `llm/ai-sdk-adapter.ts` (the AI SDK —
   `ToolLoopAgent` + `tool()` behind `AgentRuntime`), `llm/azure-adapter.ts`
   (Azure model auth, an adapter within the ai-sdk family), and
   `tools/bash/bash-tool-adapter.ts` (the `bash-tool` package → `ToolSet`).
   Only adapters import vendor SDKs. Registered in their port's registry
   (`runtimes`, `llmProviders`, sandbox provider factories).
3. **Domain services** — everything else. Pure logic written against ports,
   no vendor imports: `scm/` (git expressed as sandbox commands), `session/`
   (worktree lifecycle over scm), `tools/edit` + `tools/search` (agent tools
   defined with the port's `defineTool`, no SDK), `prompt/` (pure prompt
   composition), `agent/` (assembly of llm-runtime + prompt + tools; mode ×
   role selects toolsets, `subagents.ts` + `scheduler.ts` run the task DAG,
   `permissions.ts` gates mutating tools), `chat/` (the interaction core:
   session turns, jobs, command routing — pure, no TTY),
   `eval/` (eval contracts + graders; its Env/AgentAdapter implementations
   live in `core/eval/adapters/`, the app layer).

`scm` deliberately has no port of its own: git runs *inside* the sandbox
boundary, so retargeting execution (e.g. host-local instead of a microVM)
means writing a new **sandbox** adapter — scm, session, and all tools follow
unchanged.

## Rules

- Ports and domain services depend on zod and other lib modules only — never
  on vendor SDKs. Vendor imports (`ai`, `@ai-sdk/*`, `bash-tool`) live **only**
  in `*-adapter.ts` files. No exceptions: the agent loop, the tools, and the
  eval judge all speak the `llm` port's own vendor-free shapes (`AgentRuntime`,
  `ToolDef`/`defineTool`, `RunResult`), and the ai-sdk adapter maps them 1:1.
- Swapping the whole generation stack (a different agent SDK) is a new
  `llm/<name>-adapter.ts` registered under `runtimes`, selected by the
  `llm.runtime` config axis — no domain code changes.
- Every domain exports its own config schema; `config/index.ts` only composes
  them (`domainSchema.prefault({})`) and defines no shapes of its own.
- Registries are keyed by config values; `Object.keys(registry)` feeds
  `z.enum(...)`, so adding an entry updates the schema automatically.
- Composition roots (`core/agent-loop.ts`, `core/eval/run.ts`) are the only
  places that pick adapters and wire ports together.
