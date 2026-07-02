// Inventory service: owns stock levels and reservations. Tracing: the inbound x-request-id is
// stamped on every log line. Reserving stock decrements it immediately;
// releasing a reservation (e.g. when payment is declined downstream) restores it.
import { makeLogger } from "../lib/log";

export function createInventory(port = 0) {
  const log = makeLogger("inventory");
  const stock = new Map<string, number>([
    ["WIDGET-9", 5],
    ["GADGET-3", 2],
  ]);
  const reservations = new Map<string, { sku: string; qty: number }>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const requestId = req.headers.get("x-request-id") ?? undefined;
      if (req.method === "GET" && url.pathname === "/__logs") return Response.json(log.lines);
      if (req.method === "GET" && url.pathname.startsWith("/stock/")) {
        const sku = url.pathname.slice("/stock/".length);
        return Response.json({ sku, available: stock.get(sku) ?? 0 });
      }
      if (req.method === "POST" && url.pathname === "/reserve") {
        const { sku, qty, reservationId } = await req.json();
        const have = stock.get(sku) ?? 0;
        if (reservations.has(reservationId)) {
          log.log("warn", "reservation conflict", { reservationId, sku, requestId });
          return Response.json({ error: "reservation exists" }, { status: 409 });
        }
        if (have < qty) {
          log.log("warn", "insufficient stock", { sku, qty, have, requestId });
          return Response.json({ error: "insufficient stock" }, { status: 409 });
        }
        stock.set(sku, have - qty);
        reservations.set(reservationId, { sku, qty });
        log.log("info", "reserved", { reservationId, sku, qty, remaining: stock.get(sku), requestId });
        return Response.json({ ok: true, reservationId });
      }
      if (req.method === "POST" && url.pathname === "/release") {
        const body = await req.json();
        const r = reservations.get(body.reservationId);
        if (r) {
          stock.set(r.sku, (stock.get(r.sku) ?? 0) + r.qty);
          reservations.delete(body.reservationId);
        }
        log.log("info", "released", { reservationId: body.reservationId, requestId });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port, url: `http://localhost:${server.port}`, log };
}

if (import.meta.main) {
  const s = createInventory(4102);
  console.log(`inventory on ${s.url}`);
}
