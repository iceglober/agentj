// HTTP/SSE server — the sandboxed agent server the host TUI connects to. Bun.serve with
// bearer auth (the sandbox can reach exactly one privileged thing: the model endpoint).
// Routes mirror coder-core's `Routes`; events stream as SSE `ServerEvent`s.
import { Routes, type ServerEvent } from "coder-core";

export interface ServerOptions {
  port: number;
  /** Shared bearer token for the host↔sandbox handshake. */
  bearer: string;
  worktreeRoot: string;
}

/** Encode a protocol event as an SSE frame. */
export function sseFrame(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function startServer(opts: ServerOptions): { stop(): void } {
  const server = Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === Routes.health) {
        return Response.json({ ok: true, worktree: opts.worktreeRoot });
      }

      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${opts.bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }

      // TODO(P1): create-session, SSE event stream, message → runLoop, permission,
      // interrupt, session state. See coder-core Routes + loop.runLoop.
      return new Response("not implemented", { status: 501 });
    },
  });

  return { stop: () => server.stop(true) };
}
