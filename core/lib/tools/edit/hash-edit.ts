import { createHash } from "node:crypto";
import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { createReadTool, errMsg, readLines } from "./shared";

const lineHash = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 4);

const ANCHOR_RE = /^(\d+)#([0-9a-f]{4})$/;

/** Hash: reads expose `LINE#HASH|` anchors; edits target anchors and are
 * rejected atomically when any anchor is stale. */
export function createHashEditTools(sb: Sandbox) {
  const readFile = createReadTool(sb, {
    description:
      "Read a text file. Each output line is prefixed with an anchor `LINE#HASH|` (1-based line number, 4-hex-digit content hash). Use these anchors with the edit tool. The prefix is display-only and is not part of the file.",
    formatLine: (l, i) => `${i + 1}#${lineHash(l)}|${l}`,
  });

  const edit = defineTool({
    description:
      'Edit a file by line anchors from the latest readFile output. Each edit targets the line at `anchor` ("LINE#HASH", e.g. "12#ab3f"), or the inclusive range anchor..end_anchor. Ops: "replace" replaces the target line(s) with content, "insert_after" inserts content after the anchored line, "delete" removes the target line(s). All anchors are validated against the current file; if the file changed since your read, the whole edit is rejected — re-read and retry. Multiple edits are applied atomically in one call.',
    inputSchema: z.object({
      path: z.string(),
      edits: z
        .array(
          z.object({
            anchor: z
              .string()
              .describe('Anchor of the target line, "LINE#HASH" as shown by readFile'),
            end_anchor: z
              .string()
              .optional()
              .describe("For ranges: anchor of the last line of the range"),
            op: z.enum(["replace", "insert_after", "delete"]),
            content: z
              .string()
              .optional()
              .describe("Text to insert / replace with; may span multiple lines"),
          }),
        )
        .min(1),
    }),
    execute: async ({ path, edits }) => {
      try {
        const lines = await readLines(sb, path);

        const resolve = (anchor: string): number | string => {
          const m = ANCHOR_RE.exec(anchor);
          if (!m) return `ERROR: malformed anchor "${anchor}" (expected "LINE#HASH").`;
          const n = Number(m[1]);
          if (n < 1 || n > lines.length)
            return `ERROR: anchor "${anchor}" is out of range (file has ${lines.length} lines).`;
          const actual = lineHash(lines[n - 1]!);
          if (actual !== m[2])
            return `ERROR: stale anchor "${anchor}": line ${n} is now ${n}#${actual}|${lines[n - 1]}. Re-read the file.`;
          return n;
        };

        const resolved: {
          start: number;
          end: number;
          op: string;
          content?: string;
        }[] = [];
        for (const e of edits) {
          const start = resolve(e.anchor);
          if (typeof start === "string") return start;
          let end = start;
          if (e.end_anchor !== undefined) {
            const r = resolve(e.end_anchor);
            if (typeof r === "string") return r;
            if (r < start)
              return `ERROR: end_anchor "${e.end_anchor}" is before anchor "${e.anchor}".`;
            end = r;
          }
          if (e.op !== "delete" && e.content === undefined)
            return `ERROR: op "${e.op}" requires content.`;
          resolved.push({ start, end, op: e.op, content: e.content });
        }

        resolved.sort((a, b) => b.start - a.start);
        for (const e of resolved) {
          const newLines = e.content !== undefined ? e.content.split("\n") : [];
          if (e.op === "replace") lines.splice(e.start - 1, e.end - e.start + 1, ...newLines);
          else if (e.op === "delete") lines.splice(e.start - 1, e.end - e.start + 1);
          else lines.splice(e.end, 0, ...newLines);
        }

        await sb.writeFiles([{ path, content: lines.join("\n") }]);
        return `OK: applied ${resolved.length} edit(s). Anchors from previous reads are now stale.`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}
