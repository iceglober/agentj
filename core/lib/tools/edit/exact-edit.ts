import { tool } from "ai";
import z from "zod";
import type { Sandbox } from "../../sandbox";
import { createLinePrefixedReadTool, errMsg } from "./shared";

/** Exact string replacement, one edit per call (Claude Code-style). */
export function createExactEditTools(sb: Sandbox) {
  const readFile = createLinePrefixedReadTool(sb);

  const edit = tool({
    description:
      "Edit a file by exact string replacement. old_string must match the current file content exactly (whitespace included) and must occur exactly once — include enough surrounding lines to make it unique, or set replace_all to replace every occurrence. Never include the `LINE|` prefixes shown by readFile.",
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      try {
        const content = await sb.readFile(path);
        const count = content.split(old_string).length - 1;
        if (count === 0)
          return "ERROR: old_string not found in file. Re-read the file and match its current content exactly.";
        if (count > 1 && !replace_all)
          return `ERROR: old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`;
        const next = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);
        await sb.writeFiles([{ path, content: next }]);
        return `OK: replaced ${replace_all ? count : 1} occurrence(s).`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}
