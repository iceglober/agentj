import { describe, expect, test } from "bun:test";
import type { Sandbox } from "../sandbox";
import { agentConfigSchema, createAgentTools, type CreateAgentOptions } from ".";

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

describe("createAgentTools", () => {
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
