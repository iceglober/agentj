// Payments service: charges cards through an upstream PSP with a bounded connection pool, and
// tracks auth holds. A hold is placed per ORDER — charging the same order twice must never create a
// second hold (that's a double charge on the customer's card).
import { makeLogger } from "../lib/log";
import { pspCharge } from "../lib/psp-sim";

// Upstream PSP connections are expensive; the pool bounds how many charges run at once.
export const PAYMENT_CONNECTION_POOL = 4;

export function createPayments(port = 0) {
  const log = makeLogger("payments");
  const holds = new Map<string, { holdId: string; orderId: string; amountCents: number }>();
  let holdSeq = 9000;

  // A tiny counting semaphore over the PSP connection pool.
  let inUse = 0;
  const waiters: (() => void)[] = [];
  async function withConnection<T>(fn: () => Promise<T>): Promise<T> {
    if (inUse >= PAYMENT_CONNECTION_POOL) {
      log.log("warn", "pool exhausted — queueing", { inUse, pool: PAYMENT_CONNECTION_POOL });
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inUse++;
    try {
      return await fn();
    } finally {
      inUse--;
      waiters.shift()?.();
    }
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/__logs") return Response.json(log.lines);
      if (req.method === "GET" && url.pathname.startsWith("/holds/")) {
        const orderId = url.pathname.slice("/holds/".length);
        const all = [...holds.values()].filter((h) => h.orderId === orderId);
        return Response.json(all);
      }
      if (req.method === "POST" && url.pathname === "/charge") {
        const { orderId, amountCents, paymentToken } = await req.json();
        if (paymentToken === "declined") {
          log.log("warn", "charge declined", { orderId });
          return Response.json({ error: "declined" }, { status: 402 });
        }
        // One hold per order: record the hold BEFORE awaiting the PSP, so a concurrent duplicate
        // request (e.g. a gateway retry) sees it and returns the same hold instead of double-charging.
        const existing = [...holds.values()].find((h) => h.orderId === orderId);
        if (existing) {
          log.log("info", "duplicate charge — returning existing hold", { orderId, holdId: existing.holdId });
          return Response.json({ holdId: existing.holdId, deduped: true });
        }
        const holdId = `hold-${holdSeq++}`;
        holds.set(holdId, { holdId, orderId, amountCents });
        try {
          await withConnection(() => pspCharge(orderId, amountCents));
        } catch (err) {
          holds.delete(holdId);
          log.log("error", "psp charge failed", { orderId, error: String(err) });
          return Response.json({ error: "psp error" }, { status: 502 });
        }
        log.log("info", "auth hold created", { orderId, holdId, amountCents });
        return Response.json({ holdId });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port, url: `http://localhost:${server.port}`, log };
}

if (import.meta.main) {
  const s = createPayments(4103);
  console.log(`payments on ${s.url}`);
}
