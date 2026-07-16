import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolSet } from "../llm";
import {
  type PermissionRequest,
  permissionsConfigSchema,
  resolvePermission,
  withPermissions,
} from "./permissions";

const bashRequest = (detail: string): PermissionRequest => ({ tool: "bash", kind: "bash", detail });

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

  test("gate approval executes the tool", async () => {
    const executed: string[] = [];
    const tools = withPermissions(makeTools(executed), {
      config: permissionsConfigSchema.parse({}),
      gate: async () => "allow",
    });

    await expect(tools.bash!.execute({ command: "bun test" })).resolves.toBe("ran");
    expect(executed).toEqual(["bash:bun test"]);
  });
});
