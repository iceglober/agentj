// Public gateway: the storefront calls POST /checkout here; we forward to the orders service.
// Upstream calls have a hard timeout, and a timed-out checkout is retried once — see ops/incident.md
// for what that policy did to us in production.
import { fetchJson } from "../lib/http";
import { makeLogger } from "../lib/log";

export const UPSTREAM_TIMEOUT_MS = 250;

export function createGateway(ordersUrl: string, port = 0) {
  const log = makeLogger("gateway");
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/__logs") return Response.json(log.lines);
      if (req.method === "POST" && url.pathname === "/checkout") {
        const body = await req.json();
        const idem = req.headers.get("idempotency-key");
        const headers = idem ? { "idempotency-key": idem } : {};
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const res = await fetchJson(`${ordersUrl}/orders`, {
              method: "POST",
              body,
              headers,
              timeoutMs: UPSTREAM_TIMEOUT_MS,
            });
            log.log("info", "checkout forwarded", { attempt, status: res.status });
            return Response.json(res.body, { status: res.status });
          } catch (_err) {
            log.log("warn", "upstream timeout — retrying", { attempt, timeoutMs: UPSTREAM_TIMEOUT_MS });
          }
        }
        log.log("error", "checkout failed after retries", {});
        return Response.json({ error: "upstream timeout" }, { status: 502 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port, url: `http://localhost:${server.port}`, log };
}

if (import.meta.main) {
  const s = createGateway(process.env.ORDERS_URL ?? "http://localhost:4101", 4100);
  console.log(`gateway on ${s.url}`);
}
