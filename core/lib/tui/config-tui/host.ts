import type { Config } from "../../config";
import type { ConfigCliHandlers } from "../../config-cli";
import type { ConfigEffect, ConfigTuiData } from "./model";

/**
 * Bridges the pure config-TUI model to the real config: loads a snapshot from
 * the effective merged config and applies each effect through the existing
 * config handlers (schema validation, keychain routing, and the permission
 * rule/uncaged writers all come free). Writes land in the global config, same
 * as every other config surface.
 */
export interface ConfigTuiHostDeps {
  handlers: ConfigCliHandlers;
  /** The effective merged config (defaults + base + global + project + local). */
  loadConfig: () => Promise<Config>;
  /** Whether the Azure API key is present in the keychain. */
  hasKey: () => Promise<boolean>;
}

/** Models offered in the picker for the (only wired) Azure provider. */
const AZURE_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.4", "gpt-5.4-nano"];

export interface ConfigTuiHost {
  loadData: () => Promise<ConfigTuiData>;
  applyEffect: (effect: ConfigEffect) => Promise<string | undefined>;
}

export function createConfigTuiHost(deps: ConfigTuiHostDeps): ConfigTuiHost {
  const roleModels = (cfg: Config): { plan: string; build: string } => {
    const llm = cfg.agent.llm;
    const tier = (i: number): string => llm.tiers[i] ?? llm.model;
    return { plan: tier(llm.modes.plan), build: tier(llm.modes.build) };
  };

  const loadData = async (): Promise<ConfigTuiData> => {
    const cfg = await deps.loadConfig();
    const { plan, build } = roleModels(cfg);
    return {
      models: { plan, build },
      availableModels: Array.from(new Set([...AZURE_MODELS, plan, build])),
      providers: { connected: ["azure"], keySet: await deps.hasKey() },
      trust: {
        uncaged: cfg.permissions.uncaged,
        rules: Object.entries(cfg.permissions.rules).map(([pattern, decision]) => ({
          pattern,
          decision,
        })),
      },
      mcp: Object.entries(cfg.mcp.servers).map(([name, server]) => ({
        name,
        transport: server.transport,
      })),
    };
  };

  const applyEffect = async (effect: ConfigEffect): Promise<string | undefined> => {
    switch (effect.kind) {
      case "setModel": {
        // Named roles compile to a two-rung tier ladder: plan=tier 0, build=tier 1.
        const { plan, build } = roleModels(await deps.loadConfig());
        const nextPlan = effect.role === "plan" ? effect.model : plan;
        const nextBuild = effect.role === "build" ? effect.model : build;
        await deps.handlers.set({
          key: "agent.llm.tiers",
          value: JSON.stringify([nextPlan, nextBuild]),
        });
        await deps.handlers.set({ key: "agent.llm.modes.plan", value: "0" });
        await deps.handlers.set({ key: "agent.llm.modes.build", value: "1" });
        return `${effect.role} model → ${effect.model}`;
      }
      case "setRule":
        await deps.handlers.rule({ pattern: effect.pattern, decision: effect.decision });
        return `${effect.decision}  ${effect.pattern}`;
      case "removeRule":
        await deps.handlers.unrule({ pattern: effect.pattern });
        return `removed  ${effect.pattern}`;
      case "setUncaged":
        await deps.handlers.uncaged({ on: effect.on });
        return effect.on ? "uncaged: ON — every gated call allowed" : "uncaged: off — rules apply";
      case "addServer": {
        const value =
          effect.transport === "http"
            ? JSON.stringify({ transport: "http", url: `https://${effect.name}.example.com/mcp` })
            : JSON.stringify({ transport: "stdio", command: `${effect.name}-mcp-server` });
        await deps.handlers.set({ key: `mcp.servers.${effect.name}`, value });
        return `↻ added ${effect.name}`;
      }
      case "removeServer":
        await deps.handlers.delete({ key: `mcp.servers.${effect.name}` });
        return `↻ removed ${effect.name}`;
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
