import { describe, expect, test } from "bun:test";
import { type ConfigTuiData, createConfigTuiModel, type KeyPress } from "./model";

const DATA: ConfigTuiData = {
  models: { plan: "gpt-5.6-sol", build: "gpt-5.6-luna" },
  availableModels: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-nano"],
  providers: { connected: ["azure"], keySet: true },
  trust: {
    uncaged: false,
    rules: [
      { pattern: "edit", decision: "allow" },
      { pattern: "bash(rm -rf *)", decision: "deny" },
    ],
  },
  mcp: [{ name: "github", transport: "stdio" }],
};

const k = (name: string, extra: Partial<KeyPress> = {}): KeyPress => ({ name, ...extra });
const fresh = () => createConfigTuiModel(structuredClone(DATA));

describe("config TUI model", () => {
  test("opens on Models with the first row under the cursor", () => {
    const m = fresh();
    const v = m.view();
    expect(v.sections[0]).toEqual({ label: "Models", active: true });
    expect(v.rows[0]).toMatchObject({ label: "Plan model", value: "gpt-5.6-sol", cursor: true });
  });

  test("tab cycles sections; the cursor lands on the first focusable row", () => {
    const m = fresh();
    m.handleKey(k("tab")); // → Trust
    const v = m.view();
    expect(v.title).toContain("Trust");
    expect(v.rows.find((r) => r.cursor)?.label).toBe("Uncaged");
  });

  test("←→ on a model row emits setModel cycling the available list", () => {
    const m = fresh();
    expect(m.handleKey(k("right"))).toEqual([
      { kind: "setModel", role: "plan", model: "gpt-5.6-luna" },
    ]);
    expect(m.handleKey(k("left"))).toEqual([
      { kind: "setModel", role: "plan", model: "gpt-5.4-nano" },
    ]);
  });

  test("model overlay picks a model with ⏎", () => {
    const m = fresh();
    expect(m.handleKey(k("return"))).toEqual([]); // opens overlay
    expect(m.view().overlay?.title).toBe("plan model");
    m.handleKey(k("down"));
    expect(m.handleKey(k("return"))).toEqual([
      { kind: "setModel", role: "plan", model: "gpt-5.6-luna" },
    ]);
    expect(m.view().overlay).toBeUndefined();
  });

  test("Trust: uncaged toggles, and rules cycle deny→allow→ask", () => {
    const m = fresh();
    m.handleKey(k("tab")); // Trust, cursor on Uncaged
    expect(m.handleKey(k("space"))).toEqual([{ kind: "setUncaged", on: true }]);
    // move to the first rule
    m.handleKey(k("down"));
    expect(m.view().rows.find((r) => r.cursor)?.label).toBe("edit");
    expect(m.handleKey(k("right"))).toEqual([
      { kind: "setRule", pattern: "edit", decision: "ask" },
    ]);
    expect(m.handleKey(k("x"))).toEqual([{ kind: "removeRule", pattern: "edit" }]);
  });

  test("Trust: + add rule overlay adds with a chosen decision", () => {
    const m = fresh();
    m.handleKey(k("tab"));
    // navigate to the add-rule action (last focusable before the floor)
    let guard = 0;
    while (m.view().rows.find((r) => r.cursor)?.label !== "+ add rule" && guard++ < 20)
      m.handleKey(k("down"));
    expect(m.handleKey(k("return"))).toEqual([]); // opens overlay
    expect(m.view().overlay?.title).toBe("add rule · allow");
    m.handleKey(k("right")); // decision allow→ask
    expect(m.view().overlay?.title).toBe("add rule · ask");
    m.handleKey(k("down")); // second suggestion
    const eff = m.handleKey(k("return"));
    expect(eff[0]).toMatchObject({ kind: "setRule", decision: "ask" });
  });

  test("MCP: x removes a server, r reloads, + add opens the picker", () => {
    const m = fresh();
    m.handleKey(k("tab"));
    m.handleKey(k("tab"));
    m.handleKey(k("tab")); // MCP
    expect(m.view().rows.find((r) => r.cursor)?.label).toBe("github");
    expect(m.handleKey(k("r"))).toEqual([{ kind: "reloadMcp" }]);
    expect(m.handleKey(k("x"))).toEqual([{ kind: "removeServer", name: "github" }]);
    // after reload with the server gone, cursor rests on + add server
    m.reload({ ...DATA, mcp: [] });
    m.handleKey(k("return"));
    expect(m.view().overlay?.title).toBe("add MCP server");
    expect(m.handleKey(k("return"))).toEqual([
      { kind: "addServer", name: "github", transport: "stdio" },
    ]);
  });

  test("q and ctrl-c quit", () => {
    expect(fresh().handleKey(k("q"))).toEqual([{ kind: "quit" }]);
    expect(fresh().handleKey(k("c", { ctrl: true }))).toEqual([{ kind: "quit" }]);
  });
});
