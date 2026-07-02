import { describe, expect, test } from "bun:test";
import { boot, getJson, postJson } from "./helpers";

// The double-charge guard: charging the same order twice — including two requests IN FLIGHT AT THE
// SAME TIME (a gateway retry racing the original) — must never place a second auth hold.
describe("auth-hold dedup", () => {
  test("sequential duplicate charges return the same hold", async () => {
    const sys = boot();
    try {
      const a = await postJson(`${sys.payments.url}/charge`, {
        orderId: "o-dup-1",
        amountCents: 1000,
        paymentToken: "tok-ok",
      });
      const b = await postJson(`${sys.payments.url}/charge`, {
        orderId: "o-dup-1",
        amountCents: 1000,
        paymentToken: "tok-ok",
      });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.holdId).toBe(a.body.holdId);
      const holds = (await getJson(`${sys.payments.url}/holds/o-dup-1`)).body;
      expect(holds.length).toBe(1);
    } finally {
      sys.stop();
    }
  });

  test("CONCURRENT duplicate charges still place exactly one hold", async () => {
    const sys = boot();
    try {
      const fire = () =>
        postJson(`${sys.payments.url}/charge`, {
          orderId: "o-race-1",
          amountCents: 4200,
          paymentToken: "tok-ok",
        });
      const [a, b] = await Promise.all([fire(), fire()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const holds = (await getJson(`${sys.payments.url}/holds/o-race-1`)).body;
      expect(holds.length).toBe(1);
    } finally {
      sys.stop();
    }
  });
});
