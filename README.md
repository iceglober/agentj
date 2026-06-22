# coder

A coding agent that **prefers computation to inference** and actively manages its
**context budget** — minimizing tokens while doing real work, and measurably improving
its own efficiency over time.

> Status: **P0 scaffold.** This is the workspace skeleton — package boundaries, shared
> types, and module stubs that mirror the architecture in [`docs/PLAN.md`](docs/PLAN.md).
> See [Phases](#phases) for what's implemented vs. stubbed.

## Thesis

Any fact the agent can compute, it computes — one deterministic call returning structured
data. Everything that competes for the context window (tools, dets, docs, history) is
loaded by *relevance*, not by default. The model is reserved for genuine reasoning. coder
pairs an agent-chat with a real terminal, both pinned to one git worktree, execution
sandboxed per-worktree in a container — and gets cheaper the more you use it.

Read the full charter, evidence base, and requirements in **[`docs/PLAN.md`](docs/PLAN.md)**.

## Layout

```
coder/
  bin/coder                # binary entry — launches the TUI client
  packages/coder-core/     # protocol/types, worktree+git glue, event-log, loaders
  packages/coder-server/   # Router, AI SDK loop, tools, Capabilities, Extractors,
                           #   Succinctness controller, context-manager, Ledger,
                           #   telemetry (OTel+Counted), Distiller, registry, SSE
  packages/coder-tui/      # Ink client: chat pane + / palette + proposals review
```

In **target repos**, coder reads & writes a `.coder/` directory: `capabilities/`,
`extractors/`, `proposals/`, `fixtures/`, and `registry.json`.

## Develop

```sh
bun install
bun run typecheck
bun run test
bun bin/coder --help
```

## Phases

Each phase is independently runnable (see `docs/PLAN.md` § "Shape & phases").

- **P0** repo scaffold + worktree/container/tmux substrate (sandboxed shell, no agent). ← *this scaffold*
- **P1** agent loop + tools + Capabilities/Extractors + Router + context manager + Ledger
  + OTel + Succinctness layers 1–2, headless (`coder --once`).
- **P2** TUI: chat + `/` palette + approvals + status bar, beside the shell pane;
  Succinctness layers 3–4. ← **MVP**
- **P3** Distiller + registry/proposals review; background jobs; MCP (lazy); nested docs.

## License

MIT — see [LICENSE](LICENSE). Self-contained; zero runtime glrs dependency.
