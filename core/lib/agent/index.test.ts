import { describe, expect, test } from "bun:test";
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

  test("planner and planning workers receive only read/search capabilities", async () => {
    const config = agentConfigSchema.parse({});
    const planner = await createAgentTools(sandbox, config, {
      ...baseOptions,
      purpose: "planner",
      planning: {
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
    const worker = await createAgentTools(sandbox, config, {
      ...baseOptions,
      purpose: "planning-worker",
    });

    expect(Object.keys(planner).sort()).toEqual(["glob", "grep", "readFile", "run_subagents"]);
    expect(Object.keys(worker).sort()).toEqual(["glob", "grep", "readFile"]);
    for (const tools of [planner, worker]) {
      expect(tools).not.toHaveProperty("bash");
      expect(tools).not.toHaveProperty("writeFile");
      expect(tools).not.toHaveProperty("edit");
    }
    expect(worker).not.toHaveProperty("run_subagents");
  });

  test("builder retains mutation tools", async () => {
    const tools = await createAgentTools(sandbox, agentConfigSchema.parse({}), {
      ...baseOptions,
      purpose: "builder",
    });
    expect(tools).toHaveProperty("bash");
    expect(tools).toHaveProperty("writeFile");
    expect(tools).toHaveProperty("edit");
    expect(tools).not.toHaveProperty("run_subagents");
  });
});
