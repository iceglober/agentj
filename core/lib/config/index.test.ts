import { describe, expect, test } from "bun:test";
import {
  type ConfigFileSystem,
  configSchema,
  deleteGlobalConfigValue,
  loadChatConfig,
  loadConfig,
  mergeConfig,
  mutateGlobalConfig,
  readGlobalConfig,
  resolveGlobalConfigPath,
  setGlobalConfigValue,
} from ".";

type FileCall =
  | ["readFile", string]
  | ["mkdir", string, { recursive: true; mode: number }]
  | ["writeFile", string, string, { mode: number }]
  | ["rename", string, string]
  | ["rm", string, { force: true }]
  | ["chmod", string, number];

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

function makeFileSystem(files: Record<string, string> = {}) {
  const stored = new Map(Object.entries(files));
  const calls: FileCall[] = [];

  const fileSystem: ConfigFileSystem = {
    async readFile(path) {
      calls.push(["readFile", path]);
      const contents = stored.get(path);
      if (contents === undefined) throw missing(path);
      return contents;
    },
    async mkdir(path, options) {
      calls.push(["mkdir", path, options]);
    },
    async writeFile(path, contents, options) {
      calls.push(["writeFile", path, contents, options]);
      stored.set(path, contents);
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      const contents = stored.get(from);
      if (contents === undefined) throw missing(from);
      stored.set(to, contents);
      stored.delete(from);
    },
    async rm(path, options) {
      calls.push(["rm", path, options]);
      stored.delete(path);
    },
    async chmod(path, mode) {
      calls.push(["chmod", path, mode]);
    },
  };

  return { calls, fileSystem, stored };
}

const globalPath = "/test/global/config.json";

function globalOptions(fileSystem: ConfigFileSystem) {
  return { fileSystem, globalConfigPath: globalPath };
}

describe("global config paths", () => {
  test("uses an explicit override without HOME and otherwise derives the user config path", () => {
    expect(resolveGlobalConfigPath({ globalConfigPath: "/tmp/agentj.json", home: undefined })).toBe(
      "/tmp/agentj.json",
    );
    expect(resolveGlobalConfigPath({ home: "/users/agent" })).toBe(
      "/users/agent/.config/agentj/config.json",
    );
    expect(() => resolveGlobalConfigPath({ home: "" })).toThrow(/HOME is unavailable/);
  });
});

describe("global config reads and merges", () => {
  test("defaults project setup and MCP servers to empty", () => {
    expect(configSchema.parse({}).project.setup).toEqual([]);
    expect(configSchema.parse({}).mcp).toEqual({ servers: {}, maxOutputChars: 30_000 });
    expect(configSchema.parse({}).metrics.enabled).toBe(false);
    expect(configSchema.parse({}).agent.tools.maxOutputChars).toBe(30_000);
    expect(configSchema.parse({ project: { setup: ["bun install"] } }).project.setup).toEqual([
      "bun install",
    ]);
  });

  test("composes MCP server configuration into the root schema", () => {
    const config = configSchema.parse({
      mcp: {
        servers: {
          docs: {
            transport: "http",
            url: "https://example.com/mcp",
            headersFromEnv: { Authorization: "DOCS_TOKEN" },
            tools: { plan: ["search*"], direct: ["search_docs"] },
            resources: { plan: ["docs*"] },
          },
        },
      },
      permissions: { mcp: { allow: ["mcp_docs_search*"] } },
    });
    expect(config.mcp.servers.docs?.tools.build).toEqual(["*"]);
    expect(config.mcp.servers.docs?.resources.plan).toEqual(["docs*"]);
    expect(config.permissions.mcp.allow).toEqual(["mcp_docs_search*"]);
  });

  test("treats a missing global config as empty and rejects malformed or non-object files", async () => {
    const absent = makeFileSystem();
    await expect(readGlobalConfig(globalOptions(absent.fileSystem))).resolves.toEqual({});

    const malformed = makeFileSystem({ [globalPath]: "{" });
    await expect(readGlobalConfig(globalOptions(malformed.fileSystem))).rejects.toThrow(
      /Malformed global config.*expected JSON object/,
    );

    const array = makeFileSystem({ [globalPath]: "[]" });
    await expect(readGlobalConfig(globalOptions(array.fileSystem))).rejects.toThrow(
      /Malformed global config.*expected a JSON object/,
    );
  });

  test("deep-merges objects while later arrays and scalars replace earlier values", () => {
    expect(
      mergeConfig(
        { nested: { fromDefault: true, value: "default" }, list: ["default"], scalar: "default" },
        { nested: { fromGlobal: true, value: "global" }, list: ["global"], scalar: "global" },
        { nested: { value: "project" }, list: ["project"], scalar: "project" },
      ),
    ).toEqual({
      nested: { fromDefault: true, fromGlobal: true, value: "project" },
      list: ["project"],
      scalar: "project",
    });
  });

  test("loads valid MCP servers while reporting malformed peers without weakening other config", async () => {
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({
        agent: { steps: 42 },
        mcp: {
          servers: {
            good: { transport: "http", url: "https://example.com/mcp" },
            bad: { transport: "http", url: "not a url" },
          },
        },
      }),
    });

    const loaded = await loadChatConfig(undefined, globalOptions(fixture.fileSystem));

    expect(loaded.config.agent.steps).toBe(42);
    expect(Object.keys(loaded.config.mcp.servers)).toEqual(["good"]);
    expect(loaded.mcpIssues).toEqual([
      expect.objectContaining({
        name: "bad",
        detail: expect.stringContaining("mcp.servers.bad.url"),
        resolution: expect.stringContaining("/mcp remove bad"),
      }),
    ]);
  });

  test("merges defaults, global, then project config recursively while project arrays and scalars replace", async () => {
    const projectPath = "/project/agentj.json";
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({
        agent: {
          llm: { model: "global-model", providers: { azure: { endpoint: "https://global" } } },
          rules: "global",
        },
        eval: { prices: { model: { in: 1, out: 2 } } },
      }),
      [projectPath]: JSON.stringify({
        agent: { llm: { provider: "azure", model: "project-model" }, rules: "project" },
        eval: { prices: {} },
      }),
    });

    const config = await loadConfig(projectPath, globalOptions(fixture.fileSystem));

    expect(config.agent.llm.model).toBe("project-model");
    expect(config.agent.llm.provider).toBe("azure");
    expect(config.agent.rules).toBe("project");
    expect(config.agent.name).toBe("agentj");
    expect(config.eval.prices).toEqual({ model: { in: 1, out: 2 } });
  });
});

describe("global config mutations", () => {
  test("sets provider and model in one atomic transaction", async () => {
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({ unknown: { preserved: true } }),
    });

    await expect(
      mutateGlobalConfig(
        [
          { type: "set", path: ["agent", "llm", "provider"], value: "azure" },
          { type: "set", path: ["agent", "llm", "model"], value: "gpt-5.6-sol" },
        ],
        globalOptions(fixture.fileSystem),
      ),
    ).resolves.toBe(true);

    expect(JSON.parse(fixture.stored.get(globalPath)!)).toEqual({
      unknown: { preserved: true },
      agent: { llm: { provider: "azure", model: "gpt-5.6-sol" } },
    });
    expect(fixture.calls.filter((call) => call[0] === "writeFile")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call[0] === "rename")).toHaveLength(1);
  });

  test("rejects an invalid resulting config without writing", async () => {
    const initial = JSON.stringify({ agent: { llm: { model: "old" } } });
    const fixture = makeFileSystem({ [globalPath]: initial });

    await expect(
      mutateGlobalConfig(
        [{ type: "set", path: ["agent", "llm", "model"], value: 42 }],
        globalOptions(fixture.fileSystem),
      ),
    ).rejects.toThrow();

    expect(fixture.stored.get(globalPath)).toBe(initial);
    expect(fixture.calls.filter((call) => call[0] === "writeFile")).toHaveLength(0);
    expect(fixture.calls.filter((call) => call[0] === "rename")).toHaveLength(0);
  });

  test("keeps the original config and removes temporary output when writing or renaming fails", async () => {
    const initial = JSON.stringify({ agent: { llm: { model: "old" } } });

    for (const failingMethod of ["writeFile", "rename"] as const) {
      const fixture = makeFileSystem({ [globalPath]: initial });
      fixture.fileSystem[failingMethod] = async () => {
        throw new Error(`${failingMethod} failed`);
      };

      await expect(
        mutateGlobalConfig(
          [{ type: "set", path: ["agent", "llm", "model"], value: "new" }],
          globalOptions(fixture.fileSystem),
        ),
      ).rejects.toThrow(`Unable to write global config at ${globalPath}`);

      expect(fixture.stored.get(globalPath)).toBe(initial);
      expect([...fixture.stored.keys()]).toEqual([globalPath]);
      expect(fixture.calls.filter((call) => call[0] === "rm")).toHaveLength(1);
    }
  });

  test("deletes and sets known paths without dropping unknown JSON fields", async () => {
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({
        unknown: { preserved: true },
        agent: { llm: { provider: "old", model: "remove" } },
      }),
    });

    await expect(
      mutateGlobalConfig(
        [
          { type: "delete", path: ["agent", "llm", "model"] },
          { type: "set", path: ["agent", "llm", "provider"], value: "azure" },
        ],
        globalOptions(fixture.fileSystem),
      ),
    ).resolves.toBe(true);

    expect(JSON.parse(fixture.stored.get(globalPath)!)).toEqual({
      unknown: { preserved: true },
      agent: { llm: { provider: "azure" } },
    });
  });

  test("sets an internal validated path atomically with private directory and file modes", async () => {
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({
        unknown: { preserved: true },
        agent: { llm: { model: "old" } },
      }),
    });

    await expect(
      setGlobalConfigValue(["agent", "llm", "model"], "new", globalOptions(fixture.fileSystem)),
    ).resolves.toBe(true);

    expect(JSON.parse(fixture.stored.get(globalPath)!)).toEqual({
      unknown: { preserved: true },
      agent: { llm: { model: "new" } },
    });
    expect(fixture.calls).toContainEqual([
      "mkdir",
      "/test/global",
      { recursive: true, mode: 0o700 },
    ]);
    expect(fixture.calls).toContainEqual(["chmod", "/test/global", 0o700]);
    expect(fixture.calls).toContainEqual(["chmod", globalPath, 0o600]);

    const write = fixture.calls.find((call) => call[0] === "writeFile");
    expect(write).toBeDefined();
    expect(write![1]).not.toBe(globalPath);
    expect(write![3]).toEqual({ mode: 0o600 });
    expect(fixture.calls.some((call) => call[0] === "rename" && call[2] === globalPath)).toBe(true);
  });

  test("deletes an existing internal path once, preserves unknown fields, and is idempotent", async () => {
    const fixture = makeFileSystem({
      [globalPath]: JSON.stringify({
        unknown: { preserved: true },
        agent: { llm: { model: "remove" } },
      }),
    });

    await expect(
      deleteGlobalConfigValue(["agent", "llm", "model"], globalOptions(fixture.fileSystem)),
    ).resolves.toBe(true);
    expect(JSON.parse(fixture.stored.get(globalPath)!)).toEqual({
      unknown: { preserved: true },
      agent: { llm: {} },
    });

    const writesAfterDelete = fixture.calls.filter((call) => call[0] === "writeFile").length;
    await expect(
      deleteGlobalConfigValue(["agent", "llm", "model"], globalOptions(fixture.fileSystem)),
    ).resolves.toBe(false);
    expect(fixture.calls.filter((call) => call[0] === "writeFile")).toHaveLength(writesAfterDelete);
  });
});
