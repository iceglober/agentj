// Orders service: creates orders. Reserves stock with inventory first, then charges payment; a
// declined payment must release the reservation so the stock returns to the pool.
//
// Tracing: the inbound x-request-id (if any) is stamped on every log line and forwarded to inventory.
import { fetchJson } from "../lib/http";
import { makeLogger } from "../lib/log";

let seq = 4411;

export function createOrders(inventoryUrl: string, port = 0) {
  const log = makeLogger("orders");
  const orders = new Map<string, { id: string; sku: string; qty: number; status: string }>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const requestId = req.headers.get("x-request-id") ?? undefined;
      const trace = requestId ? { "x-request-id": requestId } : {};
      if (req.method === "GET" && url.pathname === "/__logs") return Response.json(log.lines);
      if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
        const o = orders.get(url.pathname.slice("/orders/".length));
        return o ? Response.json(o) : new Response("not found", { status: 404 });
      }
      if (req.method === "POST" && url.pathname === "/orders") {
        const { sku, qty, paymentToken } = await req.json();
        const id = `o-${seq++}`;
        const reservationId = `res-${id}`;
        log.log("info", "order received", { id, sku, qty, requestId });
        const res = await fetchJson(`${inventoryUrl}/reserve`, {
          method: "POST",
          body: { sku, qty, reservationId },
          headers: trace,
        });
        if (res.status !== 200) {
          log.log("warn", "reserve failed", { id, status: res.status, requestId });
          return Response.json({ error: "reserve failed" }, { status: 409 });
        }
        const charged = paymentToken !== "declined"; // stand-in for a real PSP call
        if (!charged) {
          log.log("warn", "payment declined — releasing reservation", { id, reservationId, requestId });
          await fetchJson(`${inventoryUrl}/release`, {
            method: "POST",
            body: { reservationId },
            headers: trace,
          });
          orders.set(id, { id, sku, qty, status: "payment_declined" });
          return Response.json({ error: "payment declined", id }, { status: 402 });
        }
        orders.set(id, { id, sku, qty, status: "confirmed" });
        log.log("info", "order confirmed", { id, reservationId, requestId });
        return Response.json({ id, status: "confirmed" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port, url: `http://localhost:${server.port}`, log };
}

if (import.meta.main) {
  const s = createOrders(process.env.INVENTORY_URL ?? "http://localhost:4102", 4101);
  console.log(`orders on ${s.url}`);
}
