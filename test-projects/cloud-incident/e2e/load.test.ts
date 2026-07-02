import { describe, expect, test } from "bun:test";
import { boot, postJson } from "./helpers";

// Capacity regression guard (INC-407): a burst of concurrent checkouts must all complete inside the
// orders service's payments deadline. If payments can't run enough charges in parallel, the tail of
// the burst queues past the deadline, orders times out, and customers see 502s.
describe("checkout under load", () => {
  test("a 16-checkout burst fully succeeds", async () => {
    const sys = boot();
    try {
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          postJson(`${sys.gateway.url}/checkout`, {
            sku: "WIDGET-9",
            qty: 1,
            paymentToken: "tok-ok",
            amountCents: 999 + i,
          }),
        ),
      );
      const byStatus = results.reduce<Record<number, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(byStatus).toEqual({ 201: 16 });
    } finally {
      sys.stop();
    }
  });
});
