import { tool } from "ai";
import { createHash } from "node:crypto";
import z from "zod";
import type { Sandbox } from "microsandbox";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const lineHash = (line: string) =>
  createHash("sha256").update(line).digest("hex").slice(0, 4);

async function readLines(sb: Sandbox, path: string): Promise<string[]> {
  const text = await sb.fs().readToString(path);
  return text.split("\n");
}

// --- Variant A: exact string replacement (Claude Code-style Edit) ---

export function createDefaultEditTools(sb: Sandbox) {
  const readFile = tool({
    description:
      "Read a text file. Each output line is prefixed with `LINE|` (1-based line number). The prefix is display-only and is not part of the file.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        const lines = await readLines(sb, path);
        return lines.map((l, i) => `${i + 1}|${l}`).join("\n");
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

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
        const content = await sb.fs().readToString(path);
        const count = content.split(old_string).length - 1;
        if (count === 0)
          return "ERROR: old_string not found in file. Re-read the file and match its current content exactly.";
        if (count > 1 && !replace_all)
          return `ERROR: old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`;
        const next = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);
        await sb.fs().write(path, next);
        return `OK: replaced ${replace_all ? count : 1} occurrence(s).`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}

// --- Variant A2: batched exact string replacement (multi-edit control) ---

export function createBatchedEditTools(sb: Sandbox) {
  const { readFile } = createDefaultEditTools(sb);

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
        let content = await sb.fs().readToString(path);
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
        await sb.fs().write(path, content);
        return `OK: applied ${edits.length} edit(s).`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}

// --- Variant B: hashline (line anchors LINE#HASH) ---

const ANCHOR_RE = /^(\d+)#([0-9a-f]{4})$/;

export function createHashlineEditTools(sb: Sandbox) {
  const readFile = tool({
    description:
      "Read a text file. Each output line is prefixed with an anchor `LINE#HASH|` (1-based line number, 4-hex-digit content hash). Use these anchors with the edit tool. The prefix is display-only and is not part of the file.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        const lines = await readLines(sb, path);
        return lines.map((l, i) => `${i + 1}#${lineHash(l)}|${l}`).join("\n");
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  const edit = tool({
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

        const resolved: { start: number; end: number; op: string; content?: string }[] = [];
        for (const e of edits) {
          const start = resolve(e.anchor);
          if (typeof start === "string") return start;
          let end = start;
          if (e.end_anchor !== undefined) {
            const r = resolve(e.end_anchor);
            if (typeof r === "string") return r;
            if (r < start) return `ERROR: end_anchor "${e.end_anchor}" is before anchor "${e.anchor}".`;
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

        await sb.fs().write(path, lines.join("\n"));
        return `OK: applied ${resolved.length} edit(s). Anchors from previous reads are now stale.`;
      } catch (e) {
        return `ERROR: ${errMsg(e)}`;
      }
    },
  });

  return { readFile, edit };
}
