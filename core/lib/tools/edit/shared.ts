import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";

export const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

export async function readLines(sb: Sandbox, path: string): Promise<string[]> {
  const text = await sb.readFile(path);
  return text.split("\n");
}

/** The read tool shared by all edit modes; only the per-line prefix and the
 * description explaining it differ per mode. */
export function createReadTool(
  sb: Sandbox,
  opts: {
    description: string;
    formatLine: (line: string, index: number) => string;
  },
) {
  return defineTool({
    description: opts.description,
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        const lines = await readLines(sb, path);
        return lines.map((l, i) => opts.formatLine(l, i)).join("\n");
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });
}

/** `LINE|`-prefixed read used by the string-replacement edit modes. */
export const createLinePrefixedReadTool = (sb: Sandbox) =>
  createReadTool(sb, {
    description:
      "Read a text file. Each output line is prefixed with `LINE|` (1-based line number). The prefix is display-only and is not part of the file.",
    formatLine: (l, i) => `${i + 1}|${l}`,
  });
