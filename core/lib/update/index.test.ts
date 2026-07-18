import { describe, expect, test } from "bun:test";
import { createUpdateService, updateConfigSchema } from "./index";

describe("updates", () => {
  test("has safe defaults and handles channels", () => {
    expect(updateConfigSchema.parse({})).toEqual({
      channel: "auto",
      package: "@glrs-dev/aj",
      checkIntervalMs: 86_400_000,
    });
  });

  test("caches checks and only reports newer versions", async () => {
    let calls = 0;
    const service = createUpdateService(
      updateConfigSchema.parse({ channel: "latest", checkIntervalMs: 100 }),
      { registry: { latest: async () => (++calls, "2.0.0") } },
      () => 10,
    );
    expect(await service.check("1.0.0")).toMatchObject({ available: "2.0.0", channel: "latest" });
    expect(await service.check("1.0.0")).toMatchObject({ available: "2.0.0" });
    expect(calls).toBe(1);
  });
});
