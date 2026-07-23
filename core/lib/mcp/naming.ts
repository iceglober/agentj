import { createHash } from "node:crypto";

/**
 * The MCP tool-naming convention, owned in one place. Every MCP tool is exposed
 * as `mcp_<server>_<tool>` — lowercased segments joined by single underscores —
 * and that same id is what permission rules match against.
 */

/** Prefix every canonical MCP tool id carries. */
export const MCP_TOOL_PREFIX = "mcp_";

const canonicalSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";

/** The canonical, permission-stable id for one server's tool (hashed if long). */
export const canonicalMcpToolName = (server: string, tool: string): string => {
  const full = `${MCP_TOOL_PREFIX}${canonicalSegment(server)}_${canonicalSegment(tool)}`;
  if (full.length <= 64) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 55)}_${suffix}`;
};

/** True when a permission pattern targets the MCP tool family. */
export const isMcpToolPattern = (pattern: string): boolean =>
  pattern === "mcp" || pattern.startsWith(MCP_TOOL_PREFIX);

/**
 * Collapse the `mcp__<server>__<tool>` ecosystem idiom to the canonical
 * `mcp_<server>_<tool>` runtime id, so a rule written either way matches.
 */
export const normalizeMcpToolPattern = (pattern: string): string =>
  pattern.replace(/^mcp__/, MCP_TOOL_PREFIX);
