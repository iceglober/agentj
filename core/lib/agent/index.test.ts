import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolSet } from "../llm";
import type { Sandbox } from "../sandbox";
import type { WebFetch, WebSearch } from "../tools/web";
import {
  agentConfigSchema,
  type CreateAgentOptions,
  childAgentConfig,
  createAgentModelRouting,
  createAgentTools,
  withAgentModelSelection,
} from ".";
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

const web: { search: WebSearch; fetch: WebFetch } = {
  search: { search: async () => ({ results: [] }) },
  fetch: { fetch: async (url) => ({ url, contentType: "text/plain", text: "page" }) },
};

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

  test("routes both provider and model overrides without mutating the parent", () => {
    const config = agentConfigSchema.parse({
      llm: { provider: "azure", model: "primary" },
      tools: { subagents: { provider: "azure", model: "child" } },
    });
    const child = childAgentConfig(config, "delegate");
    expect(child.llm).toMatchObject({ provider: "azure", model: "child" });
    expect(config.llm).toMatchObject({ provider: "azure", model: "primary" });
    expect(agentConfigSchema.safeParse({ tools: { subagents: { model: "   " } } }).success).toBe(
      false,
    );
  });

  test("without tier routing, children inherit the parent model", () => {
    const config = agentConfigSchema.parse({ llm: { model: "gpt-5.6-terra" } });
    expect(childAgentConfig(config, "delegate").llm.model).toBe("gpt-5.6-terra");
  });

  test("applies live primary and subagent selections immutably", () => {
    const original = agentConfigSchema.parse({ llm: { model: "primary" } });
    const primary = withAgentModelSelection(original, "primary", {
      provider: "azure",
      model: "next-primary",
    });
    const routed = withAgentModelSelection(primary, "subagents", {
      provider: "azure",
      model: "child",
    });
    const inherited = withAgentModelSelection(routed, "subagents", null);

    expect(original.llm.model).toBe("primary");
    expect(primary.llm.model).toBe("next-primary");
    expect(childAgentConfig(routed, "delegate").llm.model).toBe("child");
    expect(inherited.tools.subagents).toMatchObject({ concurrency: 2 });
    expect(inherited.tools.subagents.model).toBeUndefined();
    expect(childAgentConfig(inherited, "delegate").llm.model).toBe("next-primary");
  });

  test("subagents.tier resolves through the ladder", () => {
    const config = agentConfigSchema.parse({
      llm: { tiers: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
      tools: { subagents: { tier: 2 } },
    });
    expect(childAgentConfig(config, "delegate").llm.model).toBe("gpt-5.6-luna");
  });

  test("explicit subagents.model beats subagents.tier", () => {
    const config = agentConfigSchema.parse({
      llm: { tiers: ["gpt-5.6-sol", "gpt-5.6-terra"] },
      tools: { subagents: { model: "deepseek-v4-pro", tier: 1 } },
    });
    expect(childAgentConfig(config, "delegate").llm.model).toBe("deepseek-v4-pro");
  });

  test("context ceiling: off by default, warns, and children inherit it", () => {
    const config = agentConfigSchema.parse({});
    expect(config.context.softLimit).toBeUndefined();
    expect(config.context.onLimit).toBe("warn");
    const limited = agentConfigSchema.parse({
      context: { softLimit: 240_000 },
    });
    expect(limited.context.softLimit).toBe(240_000);
    expect(limited.context.onLimit).toBe("warn");
    expect(childAgentConfig(limited, "delegate").context).toEqual(limited.context);
  });

  test("the per-turn step ceiling defaults well above the SDK's 20 and flows to children", () => {
    const config = agentConfigSchema.parse({});
    expect(config.steps).toBe(100);
    expect(childAgentConfig(config, "delegate").steps).toBe(100);
    expect(agentConfigSchema.parse({ steps: 250 }).steps).toBe(250);
  });
});

describe("createAgentModelRouting", () => {
  test("routes modes through tiers until a live primary selection takes precedence", () => {
    let changes = 0;
    const routing = createAgentModelRouting(
      agentConfigSchema.parse({
        llm: {
          model: "base",
          tiers: ["frontier", "economy"],
          modes: { plan: 0, build: 1 },
        },
      }),
      () => changes++,
    );

    expect(routing.configFor("plan").llm.model).toBe("frontier");
    expect(routing.configFor("build").llm.model).toBe("economy");

    routing.configure("primary", { provider: "azure", model: "live" });
    expect(routing.configFor("plan").llm.model).toBe("live");
    expect(routing.configFor("build").llm.model).toBe("live");
    expect(routing.selections().primary).toEqual({ provider: "azure", model: "live" });
    expect(changes).toBe(1);
  });

  test("reload adopts a fresh config, drops any primary override, and signals change", () => {
    let changes = 0;
    const routing = createAgentModelRouting(
      agentConfigSchema.parse({
        llm: { model: "base", tiers: ["frontier", "economy"], modes: { plan: 0, build: 1 } },
      }),
      () => changes++,
    );
    routing.configure("primary", { provider: "azure", model: "pinned" });
    expect(routing.configFor("plan").llm.model).toBe("pinned");

    routing.reload(
      agentConfigSchema.parse({
        llm: { model: "base", tiers: ["sol", "luna"], modes: { plan: 0, build: 1 } },
      }),
    );
    // Fresh tiers route again; the live override is gone.
    expect(routing.configFor("plan").llm.model).toBe("sol");
    expect(routing.configFor("build").llm.model).toBe("luna");
    expect(changes).toBe(2); // configure + reload
  });

  test("reports explicit child routing and clears it back to inheritance", () => {
    const routing = createAgentModelRouting(agentConfigSchema.parse({ llm: { model: "primary" } }));
    expect(routing.selections().subagents).toBeNull();

    routing.configure("subagents", { provider: "azure", model: "child" });
    expect(routing.selections().subagents).toEqual({ provider: "azure", model: "child" });

    routing.configure("subagents", null);
    expect(routing.selections().subagents).toBeNull();
    expect(routing.config().tools.subagents.model).toBeUndefined();
  });
});

describe("createAgentTools", () => {
  test("run_background_job and check_background_job exist only for a primary agent given a jobs port", async () => {
    const config = agentConfigSchema.parse({});
    const jobs = {
      start: () => ({ id: "j1" }),
      inspect: () => undefined,
      renewSoftTimeout: () => false,
      abort: () => false,
    };
    const withJobs = await createAgentTools(sandbox, config, { ...baseOptions, jobs });
    expect(withJobs).toHaveProperty("run_background_job");
    expect(withJobs).toHaveProperty("check_background_job");
    expect(
      await createAgentTools(sandbox, config, { ...baseOptions, mode: "plan", jobs }),
    ).toHaveProperty("run_background_job");
    expect(await createAgentTools(sandbox, config, baseOptions)).not.toHaveProperty(
      "run_background_job",
    );
    expect(
      await createAgentTools(sandbox, childAgentConfig(config, "delegate"), {
        ...baseOptions,
        jobs,
      }),
    ).not.toHaveProperty("run_background_job");
  });

  test("run_background_job reports standard tool activity", async () => {
    const events: string[] = [];
    const tools = await createAgentTools(sandbox, agentConfigSchema.parse({}), {
      ...baseOptions,
      jobs: {
        start: () => ({ id: "j1" }),
        inspect: () => undefined,
        renewSoftTimeout: () => false,
        abort: () => false,
      },
      onToolActivity: (activity) => events.push(`${activity.phase}:${activity.tool}`),
    });

    await tools.run_background_job?.execute({ prompt: "watch CI" });
    expect(events).toEqual(["start:run_background_job", "end:run_background_job"]);
  });

  test("permission gating is strictly opt-in: no-gate builder tools behave as before", async () => {
    const config = agentConfigSchema.parse({});
    const plain = await createAgentTools(sandbox, config, baseOptions);
    const gated = await createAgentTools(sandbox, config, {
      ...baseOptions,
      permissions: {
        config: permissionsConfigSchema.parse({ rules: { "bash(*)": "deny" } }),
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
        config: permissionsConfigSchema.parse({ rules: { "bash(*)": "deny" } }),
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
        config: permissionsConfigSchema.parse({ rules: { "bash(*)": "ask" } }),
        gate: async () => {
          events.push("permission:bash");
          return "allow";
        },
      },
    });
    await allowed.bash?.execute({ command: "ls" });
    expect(events).toEqual(["permission:bash", "start:bash:ls", "end:bash:ls"]);
  });

  test("plan mode receives read/search/bash but never edit tools; research adds delegation tools", async () => {
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

    expect(Object.keys(planPrimary).sort()).toEqual([
      "bash",
      "glob",
      "grep",
      "readFile",
      "run_one_subagent",
      "run_subagents",
    ]);
    expect(Object.keys(planDelegate).sort()).toEqual(["bash", "glob", "grep", "readFile"]);
    for (const tools of [planPrimary, planDelegate]) {
      expect(tools).not.toHaveProperty("writeFile");
      expect(tools).not.toHaveProperty("edit");
    }
    expect(planDelegate).not.toHaveProperty("run_one_subagent");
    expect(planDelegate).not.toHaveProperty("run_subagents");
  });

  test("injects web research tools in both modes and for delegates", async () => {
    const primary = agentConfigSchema.parse({});
    for (const mode of ["plan", "build"] as const) {
      const primaryTools = await createAgentTools(sandbox, primary, { ...baseOptions, mode, web });
      const delegateTools = await createAgentTools(sandbox, childAgentConfig(primary, "delegate"), {
        ...baseOptions,
        mode,
        web,
      });
      for (const tools of [primaryTools, delegateTools]) {
        expect(tools).toHaveProperty("web_search");
        expect(tools).toHaveProperty("web_fetch");
      }
    }
  });

  test("injects interactive session tools for primary agents in both modes, never delegates", async () => {
    const primary = agentConfigSchema.parse({});
    const todos = { list: () => [], replace: async () => {} };
    const questions = { ask: async () => [] };
    const plan = await createAgentTools(sandbox, primary, {
      ...baseOptions,
      mode: "plan",
      todos,
      questions,
    });
    const build = await createAgentTools(sandbox, primary, { ...baseOptions, todos, questions });
    const delegate = await createAgentTools(sandbox, childAgentConfig(primary, "delegate"), {
      ...baseOptions,
      todos,
      questions,
    });

    expect(plan).toHaveProperty("update_todos");
    expect(plan).toHaveProperty("ask_user");
    expect(build).toHaveProperty("update_todos");
    expect(build).toHaveProperty("ask_user");
    expect(delegate).not.toHaveProperty("update_todos");
    expect(delegate).not.toHaveProperty("ask_user");
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

  test("authorizes and reports generic external calls under their resolved target before activity", async () => {
    const events: string[] = [];
    const tools = await createAgentTools(sandbox, agentConfigSchema.parse({}), {
      ...baseOptions,
      externalTools: {
        build: {
          tools: {
            call_mcp_tool: {
              description: "call",
              inputSchema: z.object({ tool: z.string() }),
              execute: async () => {
                events.push("execute");
                return "called";
              },
            },
          },
          permissionTargets: {
            call_mcp_tool: (input) => (input as { tool: string }).tool,
          },
        },
      },
      permissions: {
        config: permissionsConfigSchema.parse({ rules: { "mcp_*": "ask" } }),
        gate: async (request) => {
          events.push(`gate:${request.tool}`);
          return "allow";
        },
      },
      onToolActivity: (activity) => events.push(`${activity.phase}:${activity.tool}`),
    });

    await tools.call_mcp_tool?.execute({ tool: "mcp_github_create_issue" });
    expect(events).toEqual([
      "gate:mcp_github_create_issue",
      "start:mcp_github_create_issue",
      "execute",
      "end:mcp_github_create_issue",
    ]);
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
