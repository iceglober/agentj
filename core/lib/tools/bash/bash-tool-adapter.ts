import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool } from "ai";
import { createBashTool } from "bash-tool";
import type { z } from "zod";
import { defineTool, type ToolSet } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { type SpillWriter, truncateWithSpill } from "../../truncation";

/** The runtime hands each tool call its abortSignal in execute options, but
 *  bash-tool's execute drops that arg before calling sandbox.executeCommand.
 *  This context carries the calling tool's signal across the vendor boundary
 *  so the sandbox can kill the underlying process on interrupt. */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

const withCallSignal = (sb: Sandbox): Sandbox => ({
  ...sb,
  executeCommand: (command, options) =>
    sb.executeCommand(command, { ...options, signal: options?.signal ?? callSignal.getStore() }),
});

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
      callSignal.run((options as { abortSignal?: AbortSignal } | undefined)?.abortSignal, () =>
        (t as { execute: (i: unknown, o: unknown) => unknown }).execute(
          input,
          options ?? { toolCallId: crypto.randomUUID(), messages: [] },
        ),
      ),
  });

/**
 * Adapter for the `bash-tool` vendor package: stand up its sandbox-backed
 * bash/readFile/writeFile tools and translate each ai `tool()` into a ToolDef.
 */
export async function createBashToolAdapter(
  sb: Sandbox,
  opts: { root: string; maxOutputChars: number; spill?: SpillWriter },
): Promise<ToolSet> {
  const bound = (value: string, label: string): string =>
    truncateWithSpill(value, opts.maxOutputChars, opts.spill, label);
  const { tools } = await createBashTool({
    sandbox: withCallSignal(sb),
    destination: opts.root,
    // Apply our standard suffix after reserving room within this same budget.
    maxOutputLength: Number.MAX_SAFE_INTEGER,
    onAfterBashCall: ({ result }) => ({
      result: {
        ...result,
        stdout: bound(result.stdout, "bash-stdout"),
        stderr: bound(result.stderr, "bash-stderr"),
      },
    }),
  });
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) out[name] = wrap(t as Tool);
  return out;
}
