import { describe, expect, test } from "bun:test";
import {
  type Config,
  type ConfigLayer,
  type ConfigObject,
  configSchema,
  type GlobalConfigMutation,
  type WritableConfigLayer,
} from "../../config";
import { createConfigTuiHost } from "./host";

const config = (over: Record<string, unknown> = {}): Config => configSchema.parse(over) as Config;

const emptyLayers = (): Record<ConfigLayer, ConfigObject> => ({
  default: configSchema.parse({}) as ConfigObject,
  base: {},
  global: {},
  project: {},
  local: {},
});

function makeHost(opts: { cfg?: Config; layers?: Record<ConfigLayer, ConfigObject> }) {
  const writes: Array<{ layer: WritableConfigLayer; mutations: GlobalConfigMutation[] }> = [];
  const host = createConfigTuiHost({
    loadConfig: async () => opts.cfg ?? config(),
    loadLayers: async () => opts.layers ?? emptyLayers(),
    mutate: async (layer, mutations) => {
      writes.push({ layer, mutations: [...mutations] });
      return true;
    },
    hasKey: async () => true,
  });
  return { host, writes };
}

describe("config TUI host", () => {
  test("setRule writes the pattern as a literal key to the scoped layer", async () => {
    const { host, writes } = makeHost({});
    const toast = await host.applyEffect(
      { kind: "setRule", pattern: "bash(git *)", decision: "allow" },
      "project",
    );
    expect(toast).toBe("allow  bash(git *) · project");
    expect(writes).toEqual([
      {
        layer: "project",
        mutations: [{ type: "set", path: ["permissions", "rules", "bash(git *)"], value: "allow" }],
      },
    ]);
  });

  test("removeServer deletes from the scoped layer", async () => {
    const { host, writes } = makeHost({});
    await host.applyEffect({ kind: "removeServer", name: "github" }, "local");
    expect(writes[0]).toEqual({
      layer: "local",
      mutations: [{ type: "delete", path: ["mcp", "servers", "github"] }],
    });
  });

  test("setModel compiles named roles into a two-rung tier ladder", async () => {
    const { host, writes } = makeHost({
      cfg: config({ agent: { llm: { tiers: ["a", "b"], modes: { plan: 0, build: 1 } } } }),
    });
    await host.applyEffect({ kind: "setModel", role: "build", model: "c" }, "global");
    expect(writes[0]?.mutations).toEqual([
      { type: "set", path: ["agent", "llm", "tiers"], value: ["a", "c"] },
      { type: "set", path: ["agent", "llm", "modes", "plan"], value: 0 },
      { type: "set", path: ["agent", "llm", "modes", "build"], value: 1 },
    ]);
  });

  test("loadData tags each value with the highest writable layer that set it", async () => {
    const layers = emptyLayers();
    layers.project = { permissions: { rules: { edit: "allow" } } };
    layers.local = { permissions: { uncaged: true } };
    const { host } = makeHost({
      cfg: config({ permissions: { uncaged: true, rules: { edit: "allow", web: "allow" } } }),
      layers,
    });
    const data = await host.loadData();
    const edit = data.trust.rules.find((r) => r.pattern === "edit");
    const web = data.trust.rules.find((r) => r.pattern === "web");
    expect(edit?.layer).toBe("project");
    expect(web?.layer).toBe("base"); // set nowhere writable → no tag
    expect(data.trust.uncagedLayer).toBe("local");
  });
});
