# core/lib — architecture

Package-by-domain, layer-by-file. Each folder is one domain; the layer of a
file is encoded by its name, not by a `ports/` / `adapters/` tree, so adding a
provider touches exactly one folder.

## The three kinds of module

1. **Ports** — boundaries to external systems. `index.ts` in the domain folder:
   the interface, its zod config schema, and a registry keyed by config value.
   There are exactly two: `sandbox/` (command execution + file IO in an
   isolated environment) and `llm/` (model construction).
2. **Adapters** — `*-adapter.ts` next to their port, one per external SDK:
   `sandbox/microsandbox-adapter.ts`, `llm/azure-adapter.ts`. Only adapters
   import vendor SDKs. Registered in their port's registry
   (`llmProviders`, sandbox provider factories).
3. **Domain services** — everything else. Pure logic written against ports,
   no vendor imports: `scm/` (git expressed as sandbox commands), `session/`
   (worktree lifecycle over scm), `tools/` (agent tools over the sandbox),
   `prompt/` (pure prompt composition), `agent/` (assembly of llm + prompt +
   tools), `eval/` (eval contracts + graders; its Env/AgentAdapter
   implementations live in `core/eval/adapters/`, the app layer).

`scm` deliberately has no port of its own: git runs *inside* the sandbox
boundary, so retargeting execution (e.g. host-local instead of a microVM)
means writing a new **sandbox** adapter — scm, session, and all tools follow
unchanged.

## Rules

- Ports and domain services depend on zod and other lib modules only — never
  on vendor SDKs. (`ai` types are the one sanctioned exception: the tool/agent
  surface is the AI-SDK contract itself.)
- Every domain exports its own config schema; `config/index.ts` only composes
  them (`domainSchema.prefault({})`) and defines no shapes of its own.
- Registries are keyed by config values; `Object.keys(registry)` feeds
  `z.enum(...)`, so adding an entry updates the schema automatically.
- Composition roots (`core/agent-loop.ts`, `core/eval/run.ts`) are the only
  places that pick adapters and wire ports together.
