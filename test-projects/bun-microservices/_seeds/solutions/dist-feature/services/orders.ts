// Orders service: creates orders. Reserves stock with inventory first, then charges payment; a
// declined payment must release the reservation so the stock returns to the pool.
import { fetchJson } from "../lib/http";
import { makeLogger } from "../lib/log";

let seq = 4411;

export function createOrders(inventoryUrl: string, port = 0) {
  const log = makeLogger("orders");
  const orders = new Map<string, { id: string; sku: string; qty: number; status: string }>();
  // Idempotency: a replayed key returns the original outcome instead of re-reserving stock.
  const idempotency = new Map<string, { status: number; body: unknown }>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/__logs") return Response.json(log.lines);
      if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
        const o = orders.get(url.pathname.slice("/orders/".length));
        return o ? Response.json(o) : new Response("not found", { status: 404 });
      }
      if (req.method === "POST" && url.pathname === "/orders") {
        const { sku, qty, paymentToken } = await req.json();
        const idemKey = req.headers.get("idempotency-key");
        if (idemKey && idempotency.has(idemKey)) {
          const prior = idempotency.get(idemKey)!;
          log.log("info", "idempotent replay", { idemKey });
          return Response.json(prior.body, { status: 200 });
        }
        const id = `o-${seq++}`;
        const reservationId = `res-${id}`;
        log.log("info", "order received", { id, sku, qty });
        const res = await fetchJson(`${inventoryUrl}/reserve`, {
          method: "POST",
          body: { sku, qty, reservationId },
        });
        if (res.status !== 200) {
          log.log("warn", "reserve failed", { id, status: res.status });
          return Response.json({ error: "reserve failed" }, { status: 409 });
        }
        const charged = paymentToken !== "declined"; // stand-in for a real PSP call
        if (!charged) {
          log.log("warn", "payment declined — releasing reservation", { id, reservationId });
          await fetchJson(`${inventoryUrl}/release`, { method: "POST", body: { reservationId } });
          orders.set(id, { id, sku, qty, status: "payment_declined" });
          return Response.json({ error: "payment declined", id }, { status: 402 });
        }
        orders.set(id, { id, sku, qty, status: "confirmed" });
        log.log("info", "order confirmed", { id, reservationId });
        const body = { id, status: "confirmed" };
        if (idemKey) idempotency.set(idemKey, { status: 201, body });
        return Response.json(body, { status: 201 });
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
