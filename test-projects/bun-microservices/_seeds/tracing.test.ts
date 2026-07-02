import { describe, expect, test } from "bun:test";
import { boot, postJson } from "./helpers";

// Distributed tracing contract: one correlation id per request, honored end-to-end.
describe("request tracing", () => {
  test("an inbound x-request-id is echoed on the response and stamped on every service's logs", async () => {
    const sys = boot();
    try {
      const rid = "trace-e2e-1";
      const r = await postJson(
        `${sys.gateway.url}/checkout`,
        { sku: "WIDGET-9", qty: 1, paymentToken: "tok-ok" },
        { "x-request-id": rid },
      );
      expect(r.status).toBe(201);
      expect(r.headers.get("x-request-id")).toBe(rid);
      for (const svc of [sys.gateway, sys.orders, sys.inventory] as const) {
        const lines: string[] = await (await fetch(`${svc.url}/__logs`)).json();
        const hit = lines.some((l) => l.includes(`"requestId":"${rid}"`));
        expect(hit).toBe(true);
      }
    } finally {
      sys.stop();
    }
  });

  test("a request without an inbound id gets one generated at the gateway", async () => {
    const sys = boot();
    try {
      const r = await postJson(`${sys.gateway.url}/checkout`, {
        sku: "WIDGET-9",
        qty: 1,
        paymentToken: "tok-ok",
      });
      expect(r.status).toBe(201);
      const rid = r.headers.get("x-request-id");
      expect(rid).toBeTruthy();
      const lines: string[] = await (await fetch(`${sys.inventory.url}/__logs`)).json();
      expect(lines.some((l) => l.includes(`"requestId":"${rid}"`))).toBe(true);
    } finally {
      sys.stop();
    }
  });
});
