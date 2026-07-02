import { describe, expect, test } from "bun:test";
import { boot, getJson, postJson } from "./helpers";

describe("checkout across services", () => {
  test("a successful checkout confirms the order and decrements stock", async () => {
    const sys = boot();
    try {
      const before = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      const r = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "WIDGET-9",
        qty: 2,
        paymentToken: "tok-ok",
      });
      expect(r.status).toBe(201);
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before - 2);
    } finally {
      sys.stop();
    }
  });

  test("a declined payment releases the reservation — stock is unchanged", async () => {
    const sys = boot();
    try {
      const before = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      const r = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "WIDGET-9",
        qty: 2,
        paymentToken: "declined",
      });
      expect(r.status).toBe(402);
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before);
    } finally {
      sys.stop();
    }
  });

  test("stock can sell out but never oversell", async () => {
    const sys = boot();
    try {
      const a = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "GADGET-3",
        qty: 2,
        paymentToken: "tok-ok",
      });
      expect(a.status).toBe(201);
      const b = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "GADGET-3",
        qty: 1,
        paymentToken: "tok-ok",
      });
      expect(b.status).toBe(409);
      const left = (await getJson(`${sys.inventory.url}/stock/GADGET-3`)).body.available;
      expect(left).toBe(0);
    } finally {
      sys.stop();
    }
  });
});
