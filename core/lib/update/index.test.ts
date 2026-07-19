import { describe, expect, test } from "bun:test";
import { createUpdateService, resolveUpdateChannel, updateConfigSchema } from "./index";

describe("updates", () => {
  test("defaults to automatic channel selection", () => {
    expect(updateConfigSchema.parse({})).toEqual({ auto: true, channel: "auto" });
    expect(resolveUpdateChannel("0.1.0-next.15")).toBe("next");
    expect(resolveUpdateChannel("1.2.3")).toBe("latest");
  });

  test("uses persisted checks within the interval and installs only a tagged change", async () => {
    let calls = 0;
    const writes: unknown[] = [];
    const installs: string[] = [];
    const service = createUpdateService({
      config: updateConfigSchema.parse({}),
      packageName: "@glrs-dev/aj",
      registry: {
        latest: async () => {
          calls += 1;
          return "0.1.0-next.16";
        },
      },
      installer: { install: async (_name, channel) => void installs.push(channel) },
      state: { read: async () => undefined, write: async (value) => void writes.push(value) },
      now: () => 10,
    });
    expect(await service.check("0.1.0-next.15")).toMatchObject({
      available: "0.1.0-next.16",
      channel: "next",
    });
    await service.update("0.1.0-next.15");
    expect(calls).toBe(2);
    expect(installs).toEqual(["next"]);
    expect(writes).toHaveLength(2);
  });

  test("refreshes the registry for an explicit update despite a fresh current cache", async () => {
    let calls = 0;
    const installs: string[] = [];
    const cache = {
      checkedAt: 10,
      current: "0.1.0-next.15",
      channel: "next" as const,
    };
    const service = createUpdateService({
      config: updateConfigSchema.parse({}),
      packageName: "@glrs-dev/aj",
      registry: {
        latest: async () => {
          calls += 1;
          return "0.1.0-next.16";
        },
      },
      installer: { install: async (_name, channel) => void installs.push(channel) },
      state: { read: async () => cache, write: async () => {} },
      now: () => 11,
    });

    expect(await service.check("0.1.0-next.15")).toMatchObject({
      current: "0.1.0-next.15",
      channel: "next",
    });
    expect(calls).toBe(0);

    expect(await service.update("0.1.0-next.15")).toMatchObject({
      available: "0.1.0-next.16",
      channel: "next",
    });
    expect(calls).toBe(1);
    expect(installs).toEqual(["next"]);
  });
});
