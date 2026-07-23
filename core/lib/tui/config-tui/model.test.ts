import { describe, expect, test } from "bun:test";
import { type ConfigTuiData, createConfigTuiModel, type KeyPress } from "./model";

const DATA: ConfigTuiData = {
  models: {
    plan: "gpt-5.6-sol",
    build: "gpt-5.6-luna",
    planVariant: "high",
    buildVariant: "medium",
  },
  availableModels: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-nano"],
  availableVariants: ["low", "medium", "high"],
  providers: { connected: ["azure"], keySet: true },
  trust: {
    uncaged: false,
    rules: [
      { pattern: "edit", decision: "allow", layer: "base" },
      { pattern: "bash(rm -rf *)", decision: "deny", layer: "project" },
    ],
  },
  mcp: [{ name: "github", transport: "stdio" }],
  layerPaths: {
    global: "~/.config/glorious/config.json",
    project: ".glorious/config.json",
    local: ".glorious/config.local.json",
  },
};

const k = (name: string, extra: Partial<KeyPress> = {}): KeyPress => ({ name, ...extra });
const fresh = () => createConfigTuiModel(structuredClone(DATA));
/** Feed a string into a text field one printable keypress at a time. */
const type = (m: ReturnType<typeof fresh>, s: string): void => {
  for (const ch of s) m.handleKey({ name: ch === " " ? "space" : ch, char: ch });
};

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

  test("←→ does nothing on a model row — Enter opens the picker instead", () => {
    const m = fresh();
    expect(m.handleKey(k("right"))).toEqual([]);
    expect(m.handleKey(k("left"))).toEqual([]);
    expect(m.view().overlay).toBeUndefined();
    // Enter is the only way to change the model.
    expect(m.handleKey(k("return"))).toEqual([]);
    expect(m.view().overlay?.title).toBe("plan model · variant high");
  });

  test("model overlay picks a model and its variant with ⏎", () => {
    const m = fresh();
    expect(m.handleKey(k("return"))).toEqual([]); // opens overlay, seeded with the role's variant
    expect(m.view().overlay?.title).toBe("plan model · variant high");
    m.handleKey(k("down")); // second model
    m.handleKey(k("left")); // variant high → medium
    expect(m.view().overlay?.title).toBe("plan model · variant medium");
    expect(m.handleKey(k("return"))).toEqual([
      { kind: "setModel", role: "plan", model: "gpt-5.6-luna", variant: "medium" },
    ]);
    expect(m.view().overlay).toBeUndefined();
  });

  test("Plan/Build rows show the effective variant as a note", () => {
    const m = fresh();
    expect(m.view().rows[0]).toMatchObject({ label: "Plan model", note: "high" });
    expect(m.view().rows[1]).toMatchObject({ label: "Build model", note: "medium" });
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

  test("MCP: x removes a server, r reloads, + add opens the form", () => {
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
  });

  test("MCP: the add-server form captures typed name, transport, and target", () => {
    const m = fresh();
    m.handleKey(k("tab"));
    m.handleKey(k("tab"));
    m.handleKey(k("tab")); // MCP
    m.reload({ ...DATA, mcp: [] });
    m.handleKey(k("return")); // open form on the name field

    // ⏎ with empty fields does nothing — both name and target are required.
    expect(m.handleKey(k("return"))).toEqual([]);

    type(m, "linear"); // type into the name field
    m.handleKey(k("down")); // → transport
    m.handleKey(k("right")); // stdio → http
    expect(m.view().overlay?.items[1]?.note).toBe("stdio ‹http›");
    m.handleKey(k("down")); // → target (labeled "url" for http)
    expect(m.view().overlay?.items[2]?.label).toBe("url");
    type(m, "https://mcp.linear.app/sse");

    expect(m.handleKey(k("return"))).toEqual([
      {
        kind: "addServer",
        name: "linear",
        transport: "http",
        target: "https://mcp.linear.app/sse",
      },
    ]);
    expect(m.view().overlay).toBeUndefined();
  });

  test("q and ctrl-c quit", () => {
    expect(fresh().handleKey(k("q"))).toEqual([{ kind: "quit" }]);
    expect(fresh().handleKey(k("c", { ctrl: true }))).toEqual([{ kind: "quit" }]);
  });

  test("s cycles the write scope global→project→local→global, path follows", () => {
    const m = fresh();
    expect(m.view()).toMatchObject({
      scopeLabel: "Global",
      scopePath: "~/.config/glorious/config.json",
    });
    m.handleKey(k("s"));
    expect(m.scope()).toBe("project");
    expect(m.view()).toMatchObject({
      scopeLabel: "Project",
      scopePath: ".glorious/config.json",
    });
    m.handleKey(k("s"));
    expect(m.view()).toMatchObject({ scope: "local", scopePath: ".glorious/config.local.json" });
    m.handleKey(k("s"));
    expect(m.scope()).toBe("global");
  });

  test("provenance: a value's source layer shows as a note; base/default do not", () => {
    const m = fresh();
    m.handleKey(k("tab")); // Trust
    const rows = m.view().rows;
    // The base-provided rule carries no tag; the project-set rule shows "project".
    expect(rows.find((r) => r.label === "edit")?.note).toBeUndefined();
    expect(rows.find((r) => r.label === "bash(rm -rf *)")?.note).toBe("project");
  });
});
