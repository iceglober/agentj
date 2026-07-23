import {
  type Config,
  type ConfigLayer,
  type ConfigObject,
  type GlobalConfigMutation,
  valueAtConfigPath,
  type WritableConfigLayer,
} from "../../config";
import type { ConfigEffect, ConfigTuiData } from "./model";

/**
 * Bridges the pure config-TUI model to the real config: loads a snapshot from
 * the effective merged config (with per-value provenance from the raw layers)
 * and applies each effect by writing mutations to the layer the editor is
 * scoped to. Schema validation and the atomic write come from the config core;
 * the host only shapes effects into mutations and paths into provenance.
 */
export interface ConfigTuiHostDeps {
  /** The effective merged config (defaults + base + global + project + local). */
  loadConfig: () => Promise<Config>;
  /** Each writable layer's raw object, for "where is this set" provenance. */
  loadLayers: () => Promise<Record<ConfigLayer, ConfigObject>>;
  /** Apply mutations to one writable layer's file (validated + atomic). */
  mutate: (
    layer: WritableConfigLayer,
    mutations: readonly GlobalConfigMutation[],
  ) => Promise<boolean>;
  /** Whether the Azure API key is present in the keychain. */
  hasKey: () => Promise<boolean>;
}

/** Models offered in the picker for the (only wired) Azure provider. */
const AZURE_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.4", "gpt-5.4-nano"];

export interface ConfigTuiHost {
  loadData: () => Promise<ConfigTuiData>;
  applyEffect: (effect: ConfigEffect, scope: WritableConfigLayer) => Promise<string | undefined>;
}

export function createConfigTuiHost(deps: ConfigTuiHostDeps): ConfigTuiHost {
  const roleModels = (cfg: Config): { plan: string; build: string } => {
    const llm = cfg.agent.llm;
    const tier = (i: number): string => llm.tiers[i] ?? llm.model;
    return { plan: tier(llm.modes.plan), build: tier(llm.modes.build) };
  };

  const loadData = async (): Promise<ConfigTuiData> => {
    const cfg = await deps.loadConfig();
    const layers = await deps.loadLayers();
    // The highest writable layer (local > project > global) that sets any of the
    // given paths; base/default (bundled + schema) get no provenance tag.
    const source = (...paths: string[][]): ConfigLayer => {
      for (const layer of ["local", "project", "global"] as const) {
        if (paths.some((p) => valueAtConfigPath(layers[layer], p) !== undefined)) return layer;
      }
      return "base";
    };
    const modelLayer = source(["agent", "llm", "tiers"], ["agent", "llm", "model"]);
    const { plan, build } = roleModels(cfg);
    return {
      models: { plan, build, planLayer: modelLayer, buildLayer: modelLayer },
      availableModels: Array.from(new Set([...AZURE_MODELS, plan, build])),
      providers: { connected: ["azure"], keySet: await deps.hasKey() },
      trust: {
        uncaged: cfg.permissions.uncaged,
        uncagedLayer: source(["permissions", "uncaged"]),
        rules: Object.entries(cfg.permissions.rules).map(([pattern, decision]) => ({
          pattern,
          decision,
          layer: source(["permissions", "rules", pattern]),
        })),
      },
      mcp: Object.entries(cfg.mcp.servers).map(([name, server]) => ({
        name,
        transport: server.transport,
      })),
    };
  };

  const set = (path: string[], value: unknown): GlobalConfigMutation => ({
    type: "set",
    path: path as [string, ...string[]],
    value,
  });
  const del = (path: string[]): GlobalConfigMutation => ({
    type: "delete",
    path: path as [string, ...string[]],
  });

  const applyEffect = async (
    effect: ConfigEffect,
    scope: WritableConfigLayer,
  ): Promise<string | undefined> => {
    const where = ` · ${scope}`;
    switch (effect.kind) {
      case "setModel": {
        // Named roles compile to a two-rung tier ladder: plan=tier 0, build=tier 1.
        const { plan, build } = roleModels(await deps.loadConfig());
        const nextPlan = effect.role === "plan" ? effect.model : plan;
        const nextBuild = effect.role === "build" ? effect.model : build;
        await deps.mutate(scope, [
          set(["agent", "llm", "tiers"], [nextPlan, nextBuild]),
          set(["agent", "llm", "modes", "plan"], 0),
          set(["agent", "llm", "modes", "build"], 1),
        ]);
        return `${effect.role} model → ${effect.model}${where}`;
      }
      case "setRule":
        await deps.mutate(scope, [set(["permissions", "rules", effect.pattern], effect.decision)]);
        return `${effect.decision}  ${effect.pattern}${where}`;
      case "removeRule":
        await deps.mutate(scope, [del(["permissions", "rules", effect.pattern])]);
        return `removed  ${effect.pattern}${where}`;
      case "setUncaged":
        await deps.mutate(scope, [set(["permissions", "uncaged"], effect.on)]);
        return effect.on
          ? `uncaged: ON — every gated call allowed${where}`
          : `uncaged: off — rules apply${where}`;
      case "addServer": {
        // http: the target is the URL. stdio: it's a command line — split on
        // whitespace into the executable and its args (how the client spawns it).
        const [command, ...args] = effect.target.split(/\s+/).filter(Boolean);
        const value =
          effect.transport === "http"
            ? { transport: "http", url: effect.target }
            : { transport: "stdio", command, ...(args.length ? { args } : {}) };
        await deps.mutate(scope, [set(["mcp", "servers", effect.name], value)]);
        return `↻ added ${effect.name}${where}`;
      }
      case "removeServer":
        await deps.mutate(scope, [del(["mcp", "servers", effect.name])]);
        return `↻ removed ${effect.name}${where}`;
      case "reloadMcp":
        return "↻ reloaded MCP servers";
      case "connectProvider":
        return "azure is the only wired provider — key: config set --secret providers.azure.api_key";
      case "disconnectProvider":
        return "azure is the only wired provider";
      case "quit":
        return undefined;
    }
  };

  return { loadData, applyEffect };
}
