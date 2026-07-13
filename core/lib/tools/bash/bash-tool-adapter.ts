import type { Tool } from "ai";
import { createBashTool } from "bash-tool";
import type { z } from "zod";
import { defineTool, type ToolSet } from "../../llm";
import type { Sandbox } from "../../sandbox";

/** Map one ai `tool()` object (as bash-tool returns) into our ToolDef shape. */
const wrap = (t: Tool) =>
  defineTool({
    description: typeof t.description === "string" ? t.description : "",
    // bash-tool builds its tools with zod schemas; the ai type widens this to
    // FlexibleSchema, so narrow it back for our ToolDef.
    inputSchema: t.inputSchema as z.ZodType,
    // bash-tool's execute ignores the options arg today, but forward it so the
    // vendor tool still gets real call metadata when driven by the ai runtime.
    // A fallback keeps it callable if ever invoked outside that path.
    execute: (input, options) =>
      (t as { execute: (i: unknown, o: unknown) => unknown }).execute(
        input,
        options ?? { toolCallId: crypto.randomUUID(), messages: [] },
      ),
  });

/**
 * Adapter for the `bash-tool` vendor package: stand up its sandbox-backed
 * bash/readFile/writeFile tools and translate each ai `tool()` into a ToolDef.
 */
export async function createBashToolAdapter(
  sb: Sandbox,
  opts: { root: string },
): Promise<ToolSet> {
  const { tools } = await createBashTool({
    sandbox: sb,
    destination: opts.root,
  });
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) out[name] = wrap(t as Tool);
  return out;
}
