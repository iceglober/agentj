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

    const checked = await service.check("0.1.0-next.15");
    expect(checked).toMatchObject({ current: "0.1.0-next.15", channel: "next" });
    expect(checked.available).toBeUndefined(); // cached answer, not the registry's

    expect(await service.update("0.1.0-next.15")).toMatchObject({
      available: "0.1.0-next.16",
      channel: "next",
    });
    expect(installs).toEqual(["next"]);
  });

  test("a cache-served check revalidates in the background for the next launch", async () => {
    let cache: Awaited<
      ReturnType<NonNullable<Parameters<typeof createUpdateService>[0]["state"]>["read"]>
    > = {
      checkedAt: 10,
      current: "0.1.0-next.24",
      channel: "next" as const,
    };
    let calls = 0;
    const service = createUpdateService({
      config: updateConfigSchema.parse({}),
      packageName: "@glrs-dev/aj",
      registry: {
        latest: async () => {
          calls += 1;
          return "0.1.0-next.25";
        },
      },
      state: {
        read: async () => cache,
        write: async (value) => {
          cache = value;
        },
      },
      now: () => 11,
    });

    // This launch: the fresh cache answers instantly with no update.
    expect((await service.check("0.1.0-next.24")).available).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the background refresh
    expect(calls).toBe(1);
    expect(cache).toMatchObject({ available: "0.1.0-next.25", checkedAt: 11 });

    // Next launch: the revalidated cache reports the update without another fetch.
    expect((await service.check("0.1.0-next.24")).available).toBe("0.1.0-next.25");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1); // a cache that carries `available` does not re-refresh
  });
});
