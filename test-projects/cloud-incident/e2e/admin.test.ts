import { describe, expect, test } from "bun:test";
import { boot, getJson } from "./helpers";

// Admin catalog search — and the ops maintenance flag that can drain it during reindexing.
describe("admin search", () => {
  test("ranks catalog results for a query", async () => {
    const sys = boot();
    try {
      const r = await getJson(`${sys.gateway.url}/admin/search?q=widget`);
      expect(r.status).toBe(200);
      expect(r.body.results[0].sku).toBe("WIDGET-9");
    } finally {
      sys.stop();
    }
  });

  test("returns 503 while the ADMIN_MAINTENANCE flag is set", async () => {
    process.env.ADMIN_MAINTENANCE = "true";
    const sys = boot();
    try {
      const r = await getJson(`${sys.gateway.url}/admin/search?q=widget`);
      expect(r.status).toBe(503);
    } finally {
      delete process.env.ADMIN_MAINTENANCE;
      sys.stop();
    }
  });
});
