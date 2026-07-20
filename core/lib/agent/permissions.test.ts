import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolSet } from "../llm";
import {
  createSessionPermissionGate,
  describeToolInput,
  type PermissionGate,
  type PermissionPromptDecision,
  type PermissionRequest,
  permissionsConfigSchema,
  resolvePermission,
  resolveToolTarget,
  withPermissions,
  withRequestOrigin,
} from "./permissions";

const bashRequest = (detail: string): PermissionRequest => ({ tool: "bash", kind: "bash", detail });
const mcpRequest = (tool: string): PermissionRequest => ({ tool, kind: "mcp", detail: tool });
const webRequest: PermissionRequest = {
  tool: "web_fetch",
  kind: "web",
  detail: "https://example.com",
};

describe("resolvePermission", () => {
  test("deny beats allow beats default, with prefix wildcards", () => {
    const config = permissionsConfigSchema.parse({
      bash: {
        default: "ask",
        allow: ["git *", "bun test*"],
        deny: ["git push*", "rm -rf*"],
      },
    });

    expect(resolvePermission(config, bashRequest("git push origin main"))).toBe("deny");
    expect(resolvePermission(config, bashRequest("git status"))).toBe("allow");
    expect(resolvePermission(config, bashRequest("bun test core"))).toBe("allow");
    expect(resolvePermission(config, bashRequest("rm -rf /"))).toBe("deny");
    expect(resolvePermission(config, bashRequest("curl example.com"))).toBe("ask");
  });

  test("exact patterns (no wildcard) match the whole command only", () => {
    const config = permissionsConfigSchema.parse({ bash: { allow: ["ls"] } });
    expect(resolvePermission(config, bashRequest("ls"))).toBe("allow");
    expect(resolvePermission(config, bashRequest("ls -la /etc"))).toBe("ask");
  });

  test("edits follow the single edit policy", () => {
    const allow = permissionsConfigSchema.parse({});
    const deny = permissionsConfigSchema.parse({ edit: "deny" });
    const request: PermissionRequest = { tool: "edit", kind: "edit", detail: "src/a.ts" };
    expect(resolvePermission(allow, request)).toBe("allow");
    expect(resolvePermission(deny, request)).toBe("deny");
  });

  test("web access defaults to allow and can be denied", () => {
    expect(resolvePermission(permissionsConfigSchema.parse({}), webRequest)).toBe("allow");
    expect(resolvePermission(permissionsConfigSchema.parse({ web: "deny" }), webRequest)).toBe(
      "deny",
    );
  });

  test("MCP defaults to ask and matches canonical names with deny before allow", () => {
    const defaults = permissionsConfigSchema.parse({});
    expect(resolvePermission(defaults, mcpRequest("github::get_issue"))).toBe("ask");

    const config = permissionsConfigSchema.parse({
      mcp: {
        default: "ask",
        allow: ["github::*", "linear::get_issue"],
        deny: ["github::delete_*"],
      },
    });
    expect(resolvePermission(config, mcpRequest("github::delete_issue"))).toBe("deny");
    expect(resolvePermission(config, mcpRequest("github::get_issue"))).toBe("allow");
    expect(resolvePermission(config, mcpRequest("linear::get_issue"))).toBe("allow");
    expect(resolvePermission(config, mcpRequest("linear::get_issue_comments"))).toBe("ask");
  });
});

describe("createSessionPermissionGate", () => {
  test("serializes prompts and applies always to later asks in the session", async () => {
    const prompts: PermissionRequest[] = [];
    const answers: Array<(decision: PermissionPromptDecision) => void> = [];
    const gate = createSessionPermissionGate(
      (request) =>
        new Promise((resolve) => {
          prompts.push(request);
          answers.push(resolve);
        }),
    );

    const first = gate(bashRequest("curl one"));
    const second = gate(bashRequest("curl two"));
    await Promise.resolve();
    expect(prompts).toEqual([bashRequest("curl one")]);

    answers[0]?.("always");
    await expect(first).resolves.toBe("allow");
    await expect(second).resolves.toBe("allow");
    expect(prompts).toEqual([bashRequest("curl one")]);
  });
});

describe("withPermissions", () => {
  const makeTools = (executed: string[]): ToolSet => ({
    bash: {
      description: "run",
      inputSchema: z.object({ command: z.string() }),
      execute: async (input) => {
        executed.push(`bash:${(input as { command: string }).command}`);
        return "ran";
      },
    },
    edit: {
      description: "edit",
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        executed.push(`edit:${(input as { path: string }).path}`);
        return "edited";
      },
    },
    grep: {
      description: "search",
      inputSchema: z.object({ pattern: z.string() }),
      execute: async () => {
        executed.push("grep");
        return "found";
      },
    },
  });

  test("gates mutating tools, never read tools; denial returns an error string", async () => {
    const executed: string[] = [];
    const asks: PermissionRequest[] = [];
    const tools = withPermissions(makeTools(executed), {
      config: permissionsConfigSchema.parse({
        edit: "deny",
        bash: { default: "ask", allow: ["ls*"] },
      }),
      gate: async (request) => {
        asks.push(request);
        return "deny";
      },
    });

    // Read tools pass through untouched — same object, no gating.
    await tools.grep!.execute({ pattern: "x" });
    expect(executed).toEqual(["grep"]);

    // Allowed bash runs without consulting the gate.
    await tools.bash!.execute({ command: "ls -la" });
    expect(executed).toEqual(["grep", "bash:ls -la"]);
    expect(asks).toHaveLength(0);

    // Ask-path bash consults the gate; a deny becomes a tool-result string.
    const denied = await tools.bash!.execute({ command: "curl example.com" });
    expect(asks).toEqual([bashRequest("curl example.com")]);
    expect(String(denied)).toContain("Denied by user");
    expect(executed).toHaveLength(2);

    // Deny-policy edits never reach the gate.
    const deniedEdit = await tools.edit!.execute({ path: "src/a.ts" });
    expect(String(deniedEdit)).toContain("Denied by user");
    expect(asks).toHaveLength(1);
  });

  test("web policy gates outbound web tools", async () => {
    const tools = withPermissions(
      {
        web_fetch: {
          description: "fetch",
          inputSchema: z.object({ url: z.string() }),
          execute: async () => "fetched",
        },
      },
      { config: permissionsConfigSchema.parse({ web: "deny" }), gate: async () => "allow" },
    );
    await expect(tools.web_fetch!.execute({ url: "https://example.com" })).resolves.toContain(
      "Denied by user",
    );
  });

  test("gate approval executes the tool", async () => {
    const executed: string[] = [];
    const tools = withPermissions(makeTools(executed), {
      config: permissionsConfigSchema.parse({}),
      gate: async () => "allow",
    });

    await expect(tools.bash!.execute({ command: "bun test" })).resolves.toBe("ran");
    expect(executed).toEqual(["bash:bun test"]);
  });

  test("authorizes generic and direct MCP calls by their dynamic canonical targets", async () => {
    const executed: string[] = [];
    const asks: PermissionRequest[] = [];
    const directName = "mcp_github_delete_issue_1234567";
    const mcpTools: ToolSet = {
      call_mcp_tool: {
        description: "call",
        inputSchema: z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }),
        execute: async (input) => {
          executed.push(`call:${(input as { tool: string }).tool}`);
          return "called";
        },
      },
      [directName]: {
        description: "delete issue",
        inputSchema: z.object({ issue: z.number() }),
        execute: async () => {
          executed.push("direct");
          return "deleted";
        },
      },
      find_mcp_tools: {
        description: "find tools",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => {
          executed.push("find-tools");
          return "found";
        },
      },
      find_mcp_resources: {
        description: "find resources",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => {
          executed.push("find-resources");
          return "found";
        },
      },
      read_mcp_resource: {
        description: "read resource",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => {
          executed.push("read-resource");
          return "read";
        },
      },
    };
    const tools = withPermissions(mcpTools, {
      config: permissionsConfigSchema.parse({
        mcp: { allow: ["github::get_issue"], deny: ["github::delete_*"] },
      }),
      gate: async (request) => {
        asks.push(request);
        return "deny";
      },
      resolveTarget: (tool) => (tool === directName ? "github::delete_issue" : undefined),
    });

    await expect(
      tools.call_mcp_tool!.execute({ tool: "github::get_issue", arguments: { issue: 42 } }),
    ).resolves.toBe("called");
    const denied = await tools[directName]!.execute({ issue: 42 });
    expect(String(denied)).toContain("github::delete_issue");
    expect(asks).toHaveLength(0);
    expect(executed).toEqual(["call:github::get_issue"]);

    await tools.find_mcp_tools!.execute({ query: "issue" });
    await tools.find_mcp_resources!.execute({ query: "docs" });
    await tools.read_mcp_resource!.execute({ name: "github::docs/start" });
    expect(executed).toEqual([
      "call:github::get_issue",
      "find-tools",
      "find-resources",
      "read-resource",
    ]);
  });

  test("MCP asks identify the underlying tool rather than its exposed wrapper", async () => {
    const asks: PermissionRequest[] = [];
    const directName = "mcp_linear_create_issue_7654321";
    const tools = withPermissions(
      {
        [directName]: {
          description: "create issue",
          inputSchema: z.object({ title: z.string() }),
          execute: async () => "created",
        },
        call_mcp_tool: {
          description: "call",
          inputSchema: z.object({ tool: z.string() }),
          execute: async () => "called",
        },
      },
      {
        config: permissionsConfigSchema.parse({}),
        gate: async (request) => {
          asks.push(request);
          return "deny";
        },
        resolveTarget: (tool) => (tool === directName ? "linear::create_issue" : undefined),
      },
    );

    await tools[directName]!.execute({ title: "Bug" });
    await tools.call_mcp_tool!.execute({ tool: "github::get_issue" });
    expect(asks).toEqual([
      {
        tool: "linear::create_issue",
        kind: "mcp",
        detail: 'linear::create_issue: {"title":"Bug"}',
      },
      { tool: "github::get_issue", kind: "mcp", detail: "github::get_issue" },
    ]);
  });
});

describe("describeToolInput", () => {
  test("summarizes commands, paths, tool targets, task and question batches, and falls back to JSON", () => {
    expect(describeToolInput({ command: "git status" })).toBe("git status");
    expect(describeToolInput({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(describeToolInput({ tool: "github::get_issue", arguments: {} })).toBe(
      "github::get_issue",
    );
    expect(describeToolInput({ tasks: [{}, {}, {}] })).toBe("3 tasks");
    expect(describeToolInput({ questions: [{}, {}] })).toBe("2 questions");
    expect(describeToolInput({ other: 1 })).toBe('{"other":1}');
  });

  test("resolved target details are suitable for permission prompts and activity", () => {
    expect(
      resolveToolTarget(
        "mcp_linear_create_issue_7654321",
        { title: "Bug" },
        () => "linear::create_issue",
      ),
    ).toEqual({
      tool: "linear::create_issue",
      detail: 'linear::create_issue: {"title":"Bug"}',
    });
  });
});

describe("withRequestOrigin", () => {
  test("labels every request without altering the decision", async () => {
    const seen: PermissionRequest[] = [];
    const gate: PermissionGate = async (request) => {
      seen.push(request);
      return "allow";
    };
    const child = withRequestOrigin(gate, "subagent t2");
    await expect(child({ tool: "bash", kind: "bash", detail: "git push" })).resolves.toBe("allow");
    expect(seen[0]).toEqual({
      tool: "bash",
      kind: "bash",
      detail: "git push",
      origin: "subagent t2",
    });
  });
});
