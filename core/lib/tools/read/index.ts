import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { resolveWithinRoot } from "../paths";

export interface ReadToolsOptions {
  root: string;
}

/** Read-only file access for agents that must not receive the shell toolkit. */
export function createReadTools(sb: Sandbox, { root }: ReadToolsOptions) {
  return {
    readFile: defineTool({
      description: "Read a UTF-8 file inside the working root.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path inside the working root"),
      }),
      async execute({ path }) {
        try {
          return await sb.readFile(resolveWithinRoot(root, path));
        } catch (error) {
          return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),
  };
}
