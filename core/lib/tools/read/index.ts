import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { truncateWithNotice } from "../../truncation";
import { resolveWithinRoot } from "../paths";

export interface ReadToolsOptions {
  root: string;
  /**
   * Additional readable roots (e.g. the session spill dir). Relative paths
   * always resolve against `root`; an absolute path may live under any root.
   */
  extraRoots?: readonly string[];
  /** Char cap on returned content; over-cap reads say how to slice further. */
  maxOutputChars: number;
}

const readFileInput = z.object({
  path: z.string().min(1).describe("File path inside the working root"),
  offset: z.number().int().min(1).optional().describe("1-based line to start reading from"),
  limit: z.number().int().min(1).optional().describe("Max lines to return from offset"),
});

/** Read-only file access for agents that must not receive the shell toolkit. */
export function createReadTools(
  sb: Sandbox,
  { root, extraRoots = [], maxOutputChars }: ReadToolsOptions,
) {
  const resolve = (candidate: string): string => {
    try {
      return resolveWithinRoot(root, candidate);
    } catch (error) {
      for (const extra of extraRoots) {
        try {
          return resolveWithinRoot(extra, candidate);
        } catch {}
      }
      throw error;
    }
  };

  return {
    readFile: defineTool({
      description:
        "Read a UTF-8 file inside the working root. Large files are truncated; re-read with offset/limit to see specific line ranges.",
      inputSchema: readFileInput,
      async execute({ path, offset, limit }) {
        try {
          const content = await sb.readFile(resolve(path));
          const sliced =
            offset !== undefined || limit !== undefined
              ? sliceLines(content, offset ?? 1, limit)
              : content;
          if (typeof sliced !== "string") return sliced.notice;
          const bounded = truncateWithNotice(sliced, maxOutputChars);
          return bounded === sliced || offset !== undefined || limit !== undefined
            ? bounded
            : `${bounded}\n[hint: re-read with offset/limit to see specific line ranges]`;
        } catch (error) {
          return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),
  };
}

const sliceLines = (
  content: string,
  offset: number,
  limit: number | undefined,
): string | { notice: string } => {
  const lines = content.split("\n");
  if (offset > lines.length) {
    return { notice: `[empty: offset ${offset} is past the last line (${lines.length})]` };
  }
  return lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("\n");
};
