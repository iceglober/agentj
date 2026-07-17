import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolSet } from "../llm";
import type { Sandbox } from "../sandbox";
import { agentConfigSchema, type CreateAgentOptions, childAgentConfig, createAgentTools } from ".";
import { permissionsConfigSchema } from "./permissions";

const sandbox: Sandbox = {
  async executeCommand() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async readFile() {
    return "";
  },
  async writeFiles() {},
};

const baseOptions: CreateAgentOptions = {
  root: "/repo",
  ctx: {
    cwd: "/repo",
    os: "test",
    date: "2026-07-14",
    gitBranch: "main",
    gitStatusSummary: "clean",
  },
};

const externalTool = (name: string): ToolSet[string] => ({
  description: name,
  inputSchema: z.object({ value: z.string().optional() }),
  execute: async () => name,
});

describe("childAgentConfig", () => {
  test("routes children to the configured subagent model, preserving providers", () => {
    const config = agentConfigSchema.parse({
      llm: { model: "gpt-5.6-terra", providers: { azure: { resourceName: "r" } } },
      tools: { subagents: { model: "gpt-5.6-luna" } },
    });
    const child = childAgentConfig(config, "delegate");
    expect(child.role).toBe("delegate");
    expect(child.llm.model).toBe("gpt-5.6-luna");
    expect(child.llm.providers?.azure?.resourceName).toBe("r");
    // The parent config is untouched.
    expect(config.llm.model).toBe("gpt-5.6-terra");
  });

  test("without tier routing, children inherit the parent model", () => {
    const config = agentConfigSchema.parse({ llm: { model: "gpt-5.6-terra" } });
    expect(childAgentConfig(config, "delegate").llm.model).toBe("gpt-5.6-terra");
  });

  test("the per-turn step ceiling defaults well above the SDK's 20 and flows to children", () => {
    const config = agentConfigSchema.parse({});
    expect(config.steps).toBe(100);
    expect(childAgentConfig(config, "delegate").steps).toBe(100);
    expect(agentConfigSchema.parse({ steps: 250 }).steps).toBe(250);
  });
});

describe("createAgentTools", () => {
  test("permission gating is strictly opt-in: no-gate builder tools behave as before", async () => {
    const config = agentConfigSchema.parse({});
    const plain = await createAgentTools(sandbox, config, baseOptions);
    const gated = await createAgentTools(sandbox, config, {
      ...baseOptions,
      permissions: {
        config: permissionsConfigSchema.parse({ bash: { default: "deny" } }),
        gate: async () => "deny",
      },
    });
    expect(Object.keys(gated).sort()).toEqual(Object.keys(plain).sort());
    const denied = await gated.bash?.execute({ command: "ls" });
    expect(String(denied)).toContain("Denied by user");
    const allowed = await plain.bash?.execute({ command: "ls" });
    expect(String(allowed)).not.toContain("Denied by user");
  });

  test("tool activity fires around execution, after permission grants, never on deny", async () => {
    const config = agentConfigSchema.parse({});
    const events: string[] = [];
    const record = (activity: { tool: string; detail: string; phase: string }) =>
      events.push(`${activity.phase}:${activity.tool}:${activity.detail}`);

    const denied = await createAgentTools(sandbox, config, {
      ...baseOptions,
      onToolActivity: record,
      permissions: {
        config: permissionsConfigSchema.parse({ bash: { default: "deny" } }),
        gate: async () => "deny",
      },
    });
    const deniedResult = await denied.bash?.execute({ command: "ls" });
    expect(String(deniedResult)).toContain("Denied by user");
    expect(events).toEqual([]); // denial short-circuits before activity

    const allowed = await createAgentTools(sandbox, config, {
      ...baseOptions,
      onToolActivity: record,
      permissions: {
        config: permissionsConfigSchema.parse({ bash: { default: "ask" } }),
        gate: async () => {
          events.push("permission:bash");
          return "allow";
        },
      },
    });
    await allowed.bash?.execute({ command: "ls" });
    expect(events).toEqual(["permission:bash", "start:bash:ls", "end:bash:ls"]);
  });

  test("plan mode receives only read/search capabilities; research adds run_subagents", async () => {
    const config = agentConfigSchema.parse({});
    const planPrimary = await createAgentTools(sandbox, config, {
      ...baseOptions,
      mode: "plan",
      research: {
        async createWorker() {
          return {
            generate: async () => ({
              text: "",
              steps: [],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            }),
          };
        },
      },
    });
    const planDelegate = await createAgentTools(sandbox, config, {
      ...baseOptions,
      mode: "plan",
    });

    expect(Object.keys(planPrimary).sort()).toEqual(["glob", "grep", "readFile", "run_subagents"]);
    expect(Object.keys(planDelegate).sort()).toEqual(["glob", "grep", "readFile"]);
    for (const tools of [planPrimary, planDelegate]) {
      expect(tools).not.toHaveProperty("bash");
      expect(tools).not.toHaveProperty("writeFile");
      expect(tools).not.toHaveProperty("edit");
    }
    expect(planDelegate).not.toHaveProperty("run_subagents");
  });

  test("build mode (the default) retains mutation tools", async () => {
    const tools = await createAgentTools(sandbox, agentConfigSchema.parse({}), baseOptions);
    expect(tools).toHaveProperty("bash");
    expect(tools).toHaveProperty("writeFile");
    expect(tools).toHaveProperty("edit");
    expect(tools).not.toHaveProperty("run_subagents");
  });

  test("injects only the external tools selected for the primary agent's mode", async () => {
    const config = agentConfigSchema.parse({});
    const externalTools: CreateAgentOptions["externalTools"] = {
      plan: { tools: { mcp_plan: externalTool("plan") } },
      build: {
        tools: { mcp_build: externalTool("build") },
        permissionTargets: { mcp_build: () => "server::build" },
      },
    };

    const plan = await createAgentTools(sandbox, config, {
      ...baseOptions,
      mode: "plan",
      externalTools,
    });
    const build = await createAgentTools(sandbox, config, { ...baseOptions, externalTools });

    expect(plan).toHaveProperty("mcp_plan");
    expect(plan).not.toHaveProperty("mcp_build");
    expect(build).toHaveProperty("mcp_build");
    expect(build).not.toHaveProperty("mcp_plan");
    await expect(plan.mcp_plan?.execute({})).resolves.toBe("plan");
    await expect(build.mcp_build?.execute({})).resolves.toBe("build");
  });

  test("rejects external tool collisions instead of replacing built-in capabilities", async () => {
    const config = agentConfigSchema.parse({});
    await expect(
      createAgentTools(sandbox, config, {
        ...baseOptions,
        mode: "plan",
        externalTools: { plan: { tools: { readFile: externalTool("replacement") } } },
      }),
    ).rejects.toThrow("External tool name collision: readFile");
    await expect(
      createAgentTools(sandbox, config, {
        ...baseOptions,
        externalTools: { build: { tools: { bash: externalTool("replacement") } } },
      }),
    ).rejects.toThrow("External tool name collision: bash");
  });

  test("never injects external tools into delegates or background-child configs", async () => {
    const primary = agentConfigSchema.parse({});
    const externalTools: CreateAgentOptions["externalTools"] = {
      plan: { tools: { mcp_plan: externalTool("plan") } },
      build: { tools: { mcp_build: externalTool("build") } },
    };
    for (const mode of ["plan", "build"] as const) {
      const delegate = await createAgentTools(sandbox, childAgentConfig(primary, "delegate"), {
        ...baseOptions,
        mode,
        externalTools,
      });
      expect(delegate).not.toHaveProperty("mcp_plan");
      expect(delegate).not.toHaveProperty("mcp_build");
    }
  });
});
