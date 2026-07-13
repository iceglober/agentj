import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { shq } from "../../shell";
import { resolveWithinRoot } from "../paths";

// Glob patterns are interpolated into a bash -c glob expansion, so restrict
// them to glob syntax — anything shell-active is rejected, not escaped.
const GLOB_SAFE = /^[A-Za-z0-9_./*?\[\]{},\- ]+$/;

export interface SearchToolsOptions {
  /** Default directory for relative/omitted paths. */
  root: string;
}

export function createSearchTools(sb: Sandbox, { root }: SearchToolsOptions) {
  const resolve = (path?: string) => resolveWithinRoot(root, path);


  const grep = defineTool({
    description:
      "Search file contents recursively with a regex inside the working root. Returns matching lines as `path:line:content`, capped at maxResults. .git directories are skipped.",
    inputSchema: z.object({
      pattern: z.string().describe("Extended regex (ERE) to search for"),
      path: z
        .string()
        .optional()
        .describe(
          "File or directory to search inside the working root; defaults to the working directory",
        ),
      include: z
        .string()
        .optional()
        .describe('Only search files matching this glob, e.g. "*.py"'),
      ignoreCase: z.boolean().optional(),
      fixedString: z
        .boolean()
        .optional()
        .describe("Treat pattern as a literal string instead of a regex"),
      maxResults: z.number().int().min(1).max(500).default(100),
    }),
    execute: async ({ pattern, path, include, ignoreCase, fixedString, maxResults }) => {
      let resolvedPath: string;
      try {
        resolvedPath = resolve(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `ERROR: ${message}`;
      }

      const flags = [
        "-rn",
        "--exclude-dir=.git",
        ignoreCase ? "-i" : "",
        fixedString ? "-F" : "-E",
        include ? `--include=${shq(include)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const cmd = `grep ${flags} -e ${shq(pattern)} ${shq(resolvedPath)} | head -n ${maxResults + 1}`;
      const r = await sb.executeCommand(cmd);
      // grep exits 1 on no matches, >1 on real errors
      if (r.exitCode > 1) return `ERROR: ${r.stderr.trim() || `grep exited ${r.exitCode}`}`;
      const lines = r.stdout.split("\n").filter(Boolean);
      if (lines.length === 0) return "No matches.";
      if (lines.length > maxResults)
        return `${lines.slice(0, maxResults).join("\n")}\n[truncated at ${maxResults} matches — narrow the pattern or path]`;
      return lines.join("\n");
    },
  });

  const glob = defineTool({
    description:
      "List files matching a glob pattern (`**` supported) inside the working root, sorted by modification time, newest first. Capped at maxResults.",
    inputSchema: z.object({
      pattern: z.string().describe('Glob to match, e.g. "**/*.py" or "src/*.ts"'),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to match in inside the working root; defaults to the working directory",
        ),
      maxResults: z.number().int().min(1).max(1000).default(200),
    }),
    execute: async ({ pattern, path, maxResults }) => {
      if (!GLOB_SAFE.test(pattern))
        return `ERROR: pattern contains characters outside glob syntax (allowed: ${GLOB_SAFE.source}).`;

      let resolvedPath: string;
      try {
        resolvedPath = resolve(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `ERROR: ${message}`;
      }

      const cmd = `cd ${shq(resolvedPath)} && bash -O globstar -O nullglob -c 'files=( ${pattern} ); [ \${#files[@]} -gt 0 ] && ls -td -- "\${files[@]}"' | head -n ${maxResults + 1}`;
      const r = await sb.executeCommand(cmd);
      if (r.exitCode !== 0 && r.stderr.trim())
        return `ERROR: ${r.stderr.trim()}`;
      const lines = r.stdout.split("\n").filter(Boolean);
      if (lines.length === 0) return "No files match.";
      if (lines.length > maxResults)
        return `${lines.slice(0, maxResults).join("\n")}\n[truncated at ${maxResults} files — narrow the pattern]`;
      return lines.join("\n");
    },
  });

  return { grep, glob };
}
