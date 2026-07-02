// Orders service: creates orders. Reserves stock with inventory, charges payment through the
// payments service (with a hard deadline), and releases the reservation on any payment failure.
import { fetchJson } from "../lib/http";
import { makeLogger } from "../lib/log";

export const PAYMENTS_DEADLINE_MS = 300;

let seq = 7100;

export function createOrders(inventoryUrl: string, paymentsUrl: string, port = 0) {
  const log = makeLogger("orders");
  const orders = new Map<string, { id: string; sku: string; qty: number; status: string }>();

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
        const { sku, qty, paymentToken, amountCents } = await req.json();
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
        try {
          const pay = await fetchJson(`${paymentsUrl}/charge`, {
            method: "POST",
            body: { orderId: id, amountCents: amountCents ?? 1000, paymentToken },
            timeoutMs: PAYMENTS_DEADLINE_MS,
          });
          if (pay.status !== 200) {
            log.log("warn", "payment failed — releasing reservation", { id, status: pay.status });
            await fetchJson(`${inventoryUrl}/release`, { method: "POST", body: { reservationId } });
            return Response.json({ error: "payment failed", id }, { status: 402 });
          }
          orders.set(id, { id, sku, qty, status: "confirmed" });
          log.log("info", "order confirmed", { id, holdId: pay.body.holdId });
          return Response.json({ id, status: "confirmed", holdId: pay.body.holdId }, { status: 201 });
        } catch (_err) {
          log.log("error", "payments call timed out — releasing reservation", {
            id,
            deadlineMs: PAYMENTS_DEADLINE_MS,
          });
          await fetchJson(`${inventoryUrl}/release`, { method: "POST", body: { reservationId } });
          return Response.json({ error: "payments timeout", id }, { status: 502 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port, url: `http://localhost:${server.port}`, log };
}

if (import.meta.main) {
  const s = createOrders(
    process.env.INVENTORY_URL ?? "http://localhost:4102",
    process.env.PAYMENTS_URL ?? "http://localhost:4103",
    4101,
  );
  console.log(`orders on ${s.url}`);
}
