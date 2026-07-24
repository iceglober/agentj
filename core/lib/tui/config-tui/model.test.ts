import { describe, expect, test } from "bun:test";
import { type ConfigTuiData, createConfigTuiModel, type KeyPress } from "./model";

const DATA: ConfigTuiData = {
  models: {
    plan: { ref: "azure/gpt-5.6-sol", provider: "azure", model: "gpt-5.6-sol", variant: "high" },
    build: {
      ref: "azure/gpt-5.6-luna",
      provider: "azure",
      model: "gpt-5.6-luna",
      variant: "medium",
    },
  },
  modelProviders: ["azure", "openai"],
  providerModels: {
    azure: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-nano"],
    openai: ["gpt-4o", "gpt-4o-mini"],
  },
  availableVariants: ["low", "medium", "high"],
  providers: [
    { name: "azure", connected: true, keyless: false },
    { name: "openai", connected: true, keyless: false },
    { name: "bedrock", connected: false, keyless: true },
  ],
  connectableProviders: ["azure", "openai", "anthropic"],
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
  test("opens on Models; rows show the full provider/model", () => {
    const m = fresh();
    const v = m.view();
    expect(v.sections[0]).toEqual({ label: "Models", active: true });
    expect(v.rows[0]).toMatchObject({
      label: "Plan model",
      value: "azure/gpt-5.6-sol",
      note: "high",
      cursor: true,
    });
    expect(v.rows[1]).toMatchObject({ label: "Build model", value: "azure/gpt-5.6-luna" });
  });

  test("tab cycles sections; the cursor lands on the first focusable row", () => {
    const m = fresh();
    m.handleKey(k("tab")); // → Trust
    const v = m.view();
    expect(v.title).toContain("Trust");
    expect(v.rows.find((r) => r.cursor)?.label).toBe("Uncaged");
  });

  test("the column picker opens on the model column with the provider selected", () => {
    const m = fresh();
    m.handleKey(k("return")); // open on col 1 (model), provider=azure
    const ov = m.view().overlay;
    expect(ov?.title).toBe("plan model");
    expect(ov?.columns?.map((c) => c.title)).toEqual(["provider", "model · azure", "variant"]);
    // column 1 (model) is active, provider column shows azure as the trail.
    expect(ov?.columns?.[0]?.items.find((i) => i.cursor)?.label).toBe("azure");
    expect(ov?.columns?.[1]?.active).toBe(true);
    expect(ov?.columns?.[2]?.items[0]?.label).toBe("choose a model"); // not reached yet
  });

  test("navigate provider → model → variant and commit provider/model + variant", () => {
    const m = fresh();
    m.handleKey(k("return")); // col 1 (model), azure
    m.handleKey(k("left")); // ← back to col 0 (provider)
    m.handleKey(k("down")); // azure → openai
    expect(m.view().overlay?.columns?.[0]?.items.find((i) => i.cursor)?.label).toBe("openai");
    m.handleKey(k("return")); // → col 1: openai models
    expect(m.view().overlay?.columns?.[1]?.title).toBe("model · openai");
    type(m, "mini"); // search openai models → gpt-4o-mini
    expect(m.view().overlay?.columns?.[1]?.items.find((i) => i.cursor)?.note).toBe("gpt-4o-mini");
    m.handleKey(k("return")); // → col 2: variant (cursor on the carried "high")
    m.handleKey(k("up")); // high → medium
    expect(m.handleKey(k("return"))).toEqual([
      { kind: "setModel", role: "plan", model: "openai/gpt-4o-mini", variant: "medium" },
    ]);
    expect(m.view().overlay).toBeUndefined();
  });

  test("a search with no match offers the query as a literal model id", () => {
    const m = fresh();
    m.handleKey(k("return")); // col 1 (model), azure
    type(m, "o1-2024"); // no azure suggestion matches
    const modelCol = m.view().overlay?.columns?.[1];
    expect(modelCol?.items.find((i) => i.cursor)?.label).toBe("use “o1-2024”");
    m.handleKey(k("return")); // → variant
    expect(m.handleKey(k("return"))).toMatchObject([
      { kind: "setModel", role: "plan", model: "azure/o1-2024" },
    ]);
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

  test("Providers: connect form picks a provider and captures a masked key", () => {
    const m = fresh();
    m.handleKey(k("tab"));
    m.handleKey(k("tab")); // → Providers, cursor on azure (connected)
    expect(m.view().rows.find((r) => r.cursor)?.label).toBe("azure");
    // Enter opens the connect form.
    m.handleKey(k("return"));
    expect(m.view().overlay?.title).toBe("connect provider");
    m.handleKey(k("right")); // provider azure → openai
    expect(m.view().overlay?.items[0]?.note).toBe("←→ openai");
    // ⏎ with no key does nothing.
    expect(m.handleKey(k("return"))).toEqual([]);
    m.handleKey(k("down")); // → api key field
    type(m, "sk-123");
    expect(m.view().overlay?.items[1]?.note).toBe("••••••▏"); // masked
    expect(m.handleKey(k("return"))).toEqual([
      { kind: "connectProvider", provider: "openai", apiKey: "sk-123" },
    ]);
  });

  test("Providers: keyless providers show cloud auth and can't be key-connected", () => {
    const m = fresh();
    m.handleKey(k("tab"));
    m.handleKey(k("tab"));
    let guard = 0;
    while (m.view().rows.find((r) => r.cursor)?.label !== "bedrock" && guard++ < 10)
      m.handleKey(k("down"));
    const row = m.view().rows.find((r) => r.cursor);
    expect(row).toMatchObject({ label: "bedrock", value: "credentials", note: "cloud auth" });
    // Enter does not open the key form for a keyless provider.
    expect(m.handleKey(k("return"))).toEqual([]);
    expect(m.view().overlay).toBeUndefined();
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

  test("the keybar advertises ←→ only where the focused row responds to it", () => {
    const m = fresh();
    const keyNames = () => m.view().keys.map(([k]) => k);
    // Models: Enter opens the picker; ←→ does nothing → not shown.
    expect(keyNames()).toContain("⏎");
    expect(keyNames()).not.toContain("←→");
    // Trust rules cycle their decision with ←→ → shown, plus x to remove.
    m.handleKey(k("tab"));
    m.handleKey(k("down")); // onto the first rule ("edit")
    expect(m.view().rows.find((r) => r.cursor)?.label).toBe("edit");
    expect(keyNames()).toContain("←→");
    expect(keyNames()).toContain("x");
    // MCP server row: only removable → x but no ←→.
    m.handleKey(k("tab"));
    m.handleKey(k("tab")); // → MCP, cursor on the github server
    expect(keyNames()).toContain("x");
    expect(keyNames()).not.toContain("←→");
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
