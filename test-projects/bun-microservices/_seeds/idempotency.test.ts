import { describe, expect, test } from "bun:test";
import { boot, getJson, postJson } from "./helpers";

// Idempotent checkout contract (the fix for INC-231): replaying a checkout with the same
// Idempotency-Key must return the SAME order and reserve stock exactly once — that's what makes the
// gateway's timeout-retry safe.
describe("idempotent checkout", () => {
  test("replaying the same Idempotency-Key returns the same order and reserves once", async () => {
    const sys = boot();
    try {
      const before = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      const h = { "idempotency-key": "idem-42" };
      const a = await postJson(
        `${sys.gateway.url}/checkout`,
        { sku: "WIDGET-9", qty: 1, paymentToken: "tok-ok" },
        h,
      );
      expect(a.status).toBe(201);
      const b = await postJson(
        `${sys.gateway.url}/checkout`,
        { sku: "WIDGET-9", qty: 1, paymentToken: "tok-ok" },
        h,
      );
      expect([200, 201]).toContain(b.status);
      expect(b.body.id).toBe(a.body.id);
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before - 1);
    } finally {
      sys.stop();
    }
  });

  test("different keys create distinct orders and reserve separately", async () => {
    const sys = boot();
    try {
      const before = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      const a = await postJson(
        `${sys.gateway.url}/checkout`,
        { sku: "WIDGET-9", qty: 1, paymentToken: "tok-ok" },
        { "idempotency-key": "idem-a" },
      );
      const b = await postJson(
        `${sys.gateway.url}/checkout`,
        { sku: "WIDGET-9", qty: 1, paymentToken: "tok-ok" },
        { "idempotency-key": "idem-b" },
      );
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.id).not.toBe(a.body.id);
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before - 2);
    } finally {
      sys.stop();
    }
  });

  test("checkouts without a key still work", async () => {
    const sys = boot();
    try {
      const r = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "WIDGET-9",
        qty: 1,
        paymentToken: "tok-ok",
      });
      expect(r.status).toBe(201);
    } finally {
      sys.stop();
    }
  });
});
