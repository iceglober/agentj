import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, postJson } from "./helpers";

// The PSP sandbox's chaos mode: the vendor documents transient 503s and expects CLIENTS to retry.
// Checkout must succeed anyway — resilience belongs on our side of the boundary.
beforeAll(() => {
  process.env.PSP_SANDBOX_FLAKY = "1";
});
afterAll(() => {
  delete process.env.PSP_SANDBOX_FLAKY;
});

describe("checkout despite a flaky PSP sandbox", () => {
  test("6 checkouts all succeed while the vendor throws transient errors", async () => {
    const sys = boot();
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          postJson(`${sys.gateway.url}/checkout`, {
            sku: "WIDGET-9",
            qty: 1,
            paymentToken: "tok-ok",
            amountCents: 1500 + i,
          }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses).toEqual([201, 201, 201, 201, 201, 201]);
    } finally {
      sys.stop();
    }
  });
});
