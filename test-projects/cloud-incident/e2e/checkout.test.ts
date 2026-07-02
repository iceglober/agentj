import { describe, expect, test } from "bun:test";
import { boot, getJson, postJson } from "./helpers";

describe("checkout across services", () => {
  test("a successful checkout confirms the order, places one hold, and decrements stock", async () => {
    const sys = boot();
    try {
      const before = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      const r = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "WIDGET-9",
        qty: 2,
        paymentToken: "tok-ok",
        amountCents: 2599,
      });
      expect(r.status).toBe(201);
      expect(r.body.holdId).toBeTruthy();
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before - 2);
      const holds = (await getJson(`${sys.payments.url}/holds/${r.body.id}`)).body;
      expect(holds.length).toBe(1);
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
        amountCents: 2599,
      });
      expect(r.status).toBe(402);
      const after = (await getJson(`${sys.inventory.url}/stock/WIDGET-9`)).body.available;
      expect(after).toBe(before);
    } finally {
      sys.stop();
    }
  });
});
