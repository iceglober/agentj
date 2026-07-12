import { tool } from "ai";
import z from "zod";
import type { Sandbox } from "../../sandbox";
import { createLinePrefixedReadTool, errMsg } from "./shared";

/** Exact string replacement; an array of edits applied atomically per call. */
export function createBatchEditTools(sb: Sandbox) {
  const readFile = createLinePrefixedReadTool(sb);

  const edit = tool({
    description:
      "Edit a file by applying multiple exact string replacements atomically in one call. Each old_string must match the file content exactly (whitespace included) and occur exactly once — include enough surrounding lines to make it unique, or set replace_all. Edits apply in order, each against the result of the previous. If any edit fails, nothing is written. Never include the `LINE|` prefixes shown by readFile.",
    inputSchema: z.object({
      path: z.string(),
      edits: z
        .array(
          z.object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: z.boolean().optional(),
          }),
        )
        .min(1),
    }),
    execute: async ({ path, edits }) => {
      try {
        let content = await sb.readFile(path);
        for (const [i, e] of edits.entries()) {
          const count = content.split(e.old_string).length - 1;
          if (count === 0)
            return `ERROR: edit ${i + 1}/${edits.length}: old_string not found (after earlier edits in this call). Nothing was written. Re-read the file.`;
          if (count > 1 && !e.replace_all)
            return `ERROR: edit ${i + 1}/${edits.length}: old_string occurs ${count} times. Nothing was written. Add context or set replace_all.`;
          content = e.replace_all
            ? content.split(e.old_string).join(e.new_string)
            : content.replace(e.old_string, e.new_string);
        }
        await sb.writeFiles([{ path, content }]);
        return `OK: applied ${edits.length} edit(s).`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}
