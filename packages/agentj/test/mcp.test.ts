import { describe, expect, test } from "bun:test";
import { expandVars, hasStaticAuth, resolveMcpServers } from "../src/mcp/config.ts";

describe("expandVars", () => {
  test("substitutes a set variable", () => {
    expect(expandVars("Bearer ${TOK}", { TOK: "abc" })).toBe("Bearer abc");
  });
  test("uses the default when unset", () => {
    expect(expandVars("${MISSING:-fallback}", {})).toBe("fallback");
  });
  test("unset with no default → empty", () => {
    expect(expandVars("x${MISSING}y", {})).toBe("xy");
  });
});

describe("resolveMcpServers", () => {
  test("repo entries win over global on a name clash", () => {
    const global = { mcpServers: { a: { url: "https://global.example" } } };
    const repo = { mcpServers: { a: { url: "https://repo.example" } } };
    const out = resolveMcpServers(global, repo, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "a", transport: "http", url: "https://repo.example" });
  });

  test("detects stdio (command) vs remote (url) and expands vars", () => {
    const repo = {
      mcpServers: {
        local: { command: "node", args: ["server.js", "${ARG}"], env: { K: "${V}" } },
        remote: { type: "sse", url: "https://x.example", headers: { Authorization: "Bearer ${TOK}" } },
      },
    };
    const out = resolveMcpServers({}, repo, { ARG: "one", V: "two", TOK: "sek" });
    const local = out.find((s) => s.name === "local");
    const remote = out.find((s) => s.name === "remote");
    expect(local).toMatchObject({ transport: "stdio", command: "node", args: ["server.js", "one"], env: { K: "two" } });
    expect(remote).toMatchObject({ transport: "sse", url: "https://x.example" });
  });

  test("streamable-http url with no type defaults to http", () => {
    const out = resolveMcpServers({}, { mcpServers: { s: { url: "https://h.example" } } }, {});
    expect(out[0].transport).toBe("http");
  });
});

describe("hasStaticAuth", () => {
  test("true when an Authorization header is present and non-empty", () => {
    const [cfg] = resolveMcpServers({}, { mcpServers: { s: { url: "https://x", headers: { Authorization: "Bearer t" } } } }, {});
    expect(hasStaticAuth(cfg)).toBe(true);
  });
  test("false for a stdio server", () => {
    const [cfg] = resolveMcpServers({}, { mcpServers: { s: { command: "node" } } }, {});
    expect(hasStaticAuth(cfg)).toBe(false);
  });
  test("false when the header expands to empty", () => {
    const [cfg] = resolveMcpServers({}, { mcpServers: { s: { url: "https://x", headers: { Authorization: "${UNSET}" } } } }, {});
    expect(hasStaticAuth(cfg)).toBe(false);
  });
});
