import {
  type Config,
  type ConfigLayer,
  type ConfigObject,
  type GlobalConfigMutation,
  valueAtConfigPath,
  type WritableConfigLayer,
} from "../../config";
import {
  KEY_PROVIDERS,
  MODEL_VARIANTS,
  parseModelRef,
  providerNames,
  resolveTier,
  resolveTierVariant,
} from "../../llm";
import { defaultModelVariant } from "../../prompt/profiles";
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
  /** Whether a provider has an API key in the keychain. */
  hasProviderKey: (provider: string) => Promise<boolean>;
  /** Store a provider's API key in the keychain. */
  setProviderKey: (provider: string, apiKey: string) => Promise<void>;
  /** Remove a provider's API key from the keychain. */
  removeProviderKey: (provider: string) => Promise<void>;
  /** Model suggestions per provider (the models.dev catalog); memoized upstream. */
  loadProviderModels: () => Promise<Record<string, string[]>>;
  /** Display path of each writable layer's file (static for the session). */
  layerPaths: Record<WritableConfigLayer, string>;
}

const KEYLESS_PROVIDERS = providerNames.filter((p) => !KEY_PROVIDERS.includes(p));

export interface ConfigTuiHost {
  loadData: () => Promise<ConfigTuiData>;
  applyEffect: (effect: ConfigEffect, scope: WritableConfigLayer) => Promise<string | undefined>;
}

interface RoleModelData {
  provider: string;
  model: string;
  ref: string;
  variant: string;
}

export function createConfigTuiHost(deps: ConfigTuiHostDeps): ConfigTuiHost {
  // A role's provider/model (resolved from its tier) with the effective variant.
  const roleModel = (cfg: Config, role: "plan" | "build"): RoleModelData => {
    const { provider, model } = resolveTier(cfg.agent.llm, cfg.agent.llm.modes[role]);
    const variant =
      resolveTierVariant(cfg.agent.llm, cfg.agent.llm.modes[role]) ?? defaultModelVariant(model);
    return { provider, model, ref: `${provider}/${model}`, variant };
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
    const plan = roleModel(cfg, "plan");
    const build = roleModel(cfg, "build");
    const providerStatuses = await Promise.all(
      providerNames.map(async (name) => ({
        name,
        keyless: KEYLESS_PROVIDERS.includes(name),
        connected: KEYLESS_PROVIDERS.includes(name) ? false : await deps.hasProviderKey(name),
      })),
    );
    // Providers usable for models: connected key or a cloud-auth one, plus
    // whichever a role already uses (so the current selection always shows).
    const modelProviders = Array.from(
      new Set([
        ...providerStatuses.filter((p) => p.connected || p.keyless).map((p) => p.name),
        plan.provider,
        build.provider,
      ]),
    );
    // Model suggestions from the models.dev catalog; ensure each role's current
    // model appears even if the catalog omits it.
    const catalog = await deps.loadProviderModels();
    const providerModels: Record<string, string[]> = { ...catalog };
    for (const rm of [plan, build]) {
      const list = providerModels[rm.provider] ?? [];
      providerModels[rm.provider] = list.includes(rm.model) ? list : [rm.model, ...list];
    }
    return {
      models: {
        plan: { ...plan, layer: modelLayer },
        build: { ...build, layer: modelLayer },
      },
      modelProviders,
      providerModels,
      availableVariants: [...MODEL_VARIANTS],
      providers: providerStatuses,
      connectableProviders: [...KEY_PROVIDERS],
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
      layerPaths: deps.layerPaths,
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
        // Named roles compile to a two-rung tier ladder (plan=0, build=1) of
        // `provider/model` refs; variants ride alongside, both pinned to their
        // effective value so config always matches what the editor shows.
        const cfg = await deps.loadConfig();
        const plan = roleModel(cfg, "plan");
        const build = roleModel(cfg, "build");
        const nextPlan = effect.role === "plan" ? effect.model : plan.ref;
        const nextBuild = effect.role === "build" ? effect.model : build.ref;
        // Touched role takes the picked variant (or the new model's default when
        // none was given); the other role keeps its current effective variant.
        const variantFor = (role: "plan" | "build", ref: string, current: string): string => {
          if (effect.role !== role) return current;
          return effect.variant ?? defaultModelVariant(parseModelRef(ref, "azure").model);
        };
        await deps.mutate(scope, [
          set(["agent", "llm", "tiers"], [nextPlan, nextBuild]),
          set(
            ["agent", "llm", "variants"],
            [
              variantFor("plan", nextPlan, plan.variant),
              variantFor("build", nextBuild, build.variant),
            ],
          ),
          set(["agent", "llm", "modes", "plan"], 0),
          set(["agent", "llm", "modes", "build"], 1),
        ]);
        const tag = effect.variant ? ` · ${effect.variant}` : "";
        return `${effect.role} model → ${effect.model}${tag}${where}`;
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
        await deps.setProviderKey(effect.provider, effect.apiKey);
        return `connected ${effect.provider} · set its models in Models`;
      case "disconnectProvider":
        await deps.removeProviderKey(effect.provider);
        return `disconnected ${effect.provider}`;
      case "quit":
        return undefined;
    }
  };

  return { loadData, applyEffect };
}
