import { describe, expect, test } from "bun:test";
import type { ChatCommandContext } from "./command-context";
import { runConfigCommand } from "./config-command";

type Notice = { type: string; text?: string };

const makeContext = (over: Partial<ChatCommandContext> = {}): ChatCommandContext =>
  ({ emit: () => {}, ...over }) as unknown as ChatCommandContext;

describe("runConfigCommand", () => {
  test("bare /config launches the interactive TUI when the screen supports it", async () => {
    let launched = 0;
    await runConfigCommand(makeContext({ launchConfigTui: async () => void launched++ }), "");
    expect(launched).toBe(1);
  });

  test("bare /config falls back to the usage notice without a TUI-capable screen", async () => {
    const notices: Notice[] = [];
    await runConfigCommand(makeContext({ emit: (event) => notices.push(event as Notice) }), "");
    expect(notices[0]?.text).toContain("Usage: /config");
  });

  test("`/config get <path>` still routes to the get handler", async () => {
    const gets: string[] = [];
    const context = makeContext({
      launchConfigTui: async () => {},
      config: {
        get: async ({ key }) => {
          gets.push(key);
          return { ok: true, key, storage: "global_config", value: "x" };
        },
        set: async () => ({ ok: true, key: "", storage: "global_config" }),
        delete: async () => ({ ok: true, key: "", storage: "global_config" }),
      },
    });
    await runConfigCommand(context, "get agent.llm.model");
    expect(gets).toEqual(["agent.llm.model"]);
  });
});
