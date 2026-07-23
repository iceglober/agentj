import { describe, expect, test } from "bun:test";
import {
  canonicalMcpToolName,
  isMcpToolPattern,
  MCP_TOOL_PREFIX,
  normalizeMcpToolPattern,
} from "./naming";

describe("canonicalMcpToolName", () => {
  test("lowercases and underscores server and tool segments", () => {
    expect(canonicalMcpToolName("Local-Server", "Foo Bar")).toBe("mcp_local_server_foo_bar");
  });

  test("hashes ids longer than 64 characters to a stable suffix", () => {
    const long = canonicalMcpToolName("a".repeat(60), "b".repeat(60));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith(MCP_TOOL_PREFIX)).toBe(true);
    // Deterministic.
    expect(canonicalMcpToolName("a".repeat(60), "b".repeat(60))).toBe(long);
  });
});

describe("permission pattern helpers", () => {
  test("isMcpToolPattern recognizes the mcp family, not other tools", () => {
    expect(isMcpToolPattern("mcp")).toBe(true);
    expect(isMcpToolPattern("mcp_linear_get_issue")).toBe(true);
    expect(isMcpToolPattern("mcp_linear_*")).toBe(true);
    expect(isMcpToolPattern("bash(git *)")).toBe(false);
    expect(isMcpToolPattern("edit")).toBe(false);
  });

  test("normalizeMcpToolPattern collapses the mcp__ alias to the canonical form", () => {
    expect(normalizeMcpToolPattern("mcp__linear_get_issue")).toBe("mcp_linear_get_issue");
    expect(normalizeMcpToolPattern("mcp_github_*")).toBe("mcp_github_*");
  });
});
