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
  const keys = new Map<string, string>();
  const host = createConfigTuiHost({
    loadConfig: async () => opts.cfg ?? config(),
    loadLayers: async () => opts.layers ?? emptyLayers(),
    mutate: async (layer, mutations) => {
      writes.push({ layer, mutations: [...mutations] });
      return true;
    },
    hasProviderKey: async (provider) => keys.has(provider),
    setProviderKey: async (provider, apiKey) => {
      keys.set(provider, apiKey);
    },
    removeProviderKey: async (provider) => {
      keys.delete(provider);
    },
    layerPaths: {
      global: "~/.config/glorious/config.json",
      project: ".glorious/config.json",
      local: ".glorious/config.local.json",
    },
  });
  return { host, writes, keys };
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

  test("addServer stores real user input: URL for http, command+args for stdio", async () => {
    const { host, writes } = makeHost({});
    await host.applyEffect(
      {
        kind: "addServer",
        name: "linear",
        transport: "http",
        target: "https://mcp.linear.app/sse",
      },
      "project",
    );
    await host.applyEffect(
      { kind: "addServer", name: "sentry", transport: "stdio", target: "npx @sentry/mcp-server" },
      "project",
    );
    expect(writes[0]?.mutations).toEqual([
      {
        type: "set",
        path: ["mcp", "servers", "linear"],
        value: { transport: "http", url: "https://mcp.linear.app/sse" },
      },
    ]);
    expect(writes[1]?.mutations).toEqual([
      {
        type: "set",
        path: ["mcp", "servers", "sentry"],
        value: { transport: "stdio", command: "npx", args: ["@sentry/mcp-server"] },
      },
    ]);
  });

  test("setModel writes tiers + parallel variants, keeping the untouched role's override", async () => {
    const { host, writes } = makeHost({
      cfg: config({
        agent: {
          llm: { tiers: ["a", "b"], variants: ["high", "low"], modes: { plan: 0, build: 1 } },
        },
      }),
    });
    // Change only the build model + variant; plan's variant override is preserved.
    await host.applyEffect(
      { kind: "setModel", role: "build", model: "c", variant: "xhigh" },
      "global",
    );
    expect(writes[0]?.mutations).toEqual([
      { type: "set", path: ["agent", "llm", "tiers"], value: ["a", "c"] },
      { type: "set", path: ["agent", "llm", "variants"], value: ["high", "xhigh"] },
      { type: "set", path: ["agent", "llm", "modes", "plan"], value: 0 },
      { type: "set", path: ["agent", "llm", "modes", "build"], value: 1 },
    ]);
  });

  test("setModel with no override falls back to the model profile's default variant", async () => {
    const { host, writes } = makeHost({}); // empty config: no tiers/variants
    await host.applyEffect({ kind: "setModel", role: "plan", model: "gpt-5.6-sol" }, "project");
    const variants = writes[0]?.mutations.find(
      (m) => m.type === "set" && m.path.join(".") === "agent.llm.variants",
    );
    // gpt-5.6-sol's profile default is "high"; build falls back to its default too.
    expect(variants).toMatchObject({ value: ["high", "medium"] });
  });

  test("connect/disconnect store and remove a provider's keychain key", async () => {
    const { host, keys } = makeHost({});
    await host.applyEffect(
      { kind: "connectProvider", provider: "openai", apiKey: "sk-1" },
      "global",
    );
    expect(keys.get("openai")).toBe("sk-1");
    await host.applyEffect({ kind: "disconnectProvider", provider: "openai" }, "global");
    expect(keys.has("openai")).toBe(false);
  });

  test("loadData lists every provider with connection status; keyless use the cloud chain", async () => {
    const { host, keys } = makeHost({});
    keys.set("anthropic", "sk-a");
    const data = await host.loadData();
    const byName = Object.fromEntries(data.providers.map((p) => [p.name, p]));
    expect(byName.anthropic).toMatchObject({ connected: true, keyless: false });
    expect(byName.openai).toMatchObject({ connected: false, keyless: false });
    expect(byName.bedrock).toMatchObject({ keyless: true });
    expect(byName.vertex).toMatchObject({ keyless: true });
    expect(data.connectableProviders).toContain("openai");
    expect(data.connectableProviders).not.toContain("bedrock");
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
