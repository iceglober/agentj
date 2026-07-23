import { rgPath } from "@vscode/ripgrep";
import z from "zod";
import { defineTool } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { shq } from "../../shell";
import { resolveWithinRoot } from "../paths";

// The bundled ripgrep binary (@vscode/ripgrep) — always present, so neither
// tool depends on `rg` being on the host PATH.
const RG = shq(rgPath);
// Keep .git out of results even when the caller opts into ignored/hidden files.
// Listed last so it wins ripgrep's "later glob takes precedence" ordering.
const EXCLUDE_GIT = `--glob ${shq("!.git")}`;

export interface SearchToolsOptions {
  /** Default directory for relative/omitted paths. */
  root: string;
}

export function createSearchTools(sb: Sandbox, { root }: SearchToolsOptions) {
  const resolve = (path?: string) => resolveWithinRoot(root, path);

  const grep = defineTool({
    description:
      "Search file contents recursively with a regex inside the working root, powered by ripgrep. Returns matching lines as `path:line:content`, capped at maxResults. Respects .gitignore and skips hidden/.git files by default — set includeIgnored to search everything.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex to search for (ripgrep/Rust syntax)"),
      path: z
        .string()
        .optional()
        .describe(
          "File or directory to search inside the working root; defaults to the working directory",
        ),
      include: z.string().optional().describe('Only search files matching this glob, e.g. "*.py"'),
      ignoreCase: z.boolean().optional(),
      fixedString: z
        .boolean()
        .optional()
        .describe("Treat pattern as a literal string instead of a regex"),
      includeIgnored: z
        .boolean()
        .optional()
        .describe("Also search git-ignored and hidden files (still skips .git)"),
      maxResults: z.number().int().min(1).max(500).default(100),
    }),
    execute: async ({
      pattern,
      path,
      include,
      ignoreCase,
      fixedString,
      includeIgnored,
      maxResults,
    }) => {
      let resolvedPath: string;
      try {
        resolvedPath = resolve(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `ERROR: ${message}`;
      }

      const flags = [
        "--with-filename",
        "--line-number",
        "--no-heading",
        "--color=never",
        ignoreCase ? "--ignore-case" : "",
        fixedString ? "--fixed-strings" : "",
        includeIgnored ? "--no-ignore --hidden" : "",
        include ? `--glob ${shq(include)}` : "",
        EXCLUDE_GIT,
      ]
        .filter(Boolean)
        .join(" ");
      const cmd = `${RG} ${flags} -e ${shq(pattern)} ${shq(resolvedPath)} | head -n ${maxResults + 1}`;
      const r = await sb.executeCommand(cmd);
      // ripgrep exits 1 on no matches, 2 on real errors (masked by head unless
      // the sandbox surfaces it); a non-empty stderr with no output is an error.
      if (r.exitCode > 1) return `ERROR: ${r.stderr.trim() || `ripgrep exited ${r.exitCode}`}`;
      const lines = r.stdout.split("\n").filter(Boolean);
      if (lines.length === 0) return r.stderr.trim() ? `ERROR: ${r.stderr.trim()}` : "No matches.";
      if (lines.length > maxResults)
        return `${lines.slice(0, maxResults).join("\n")}\n[truncated at ${maxResults} matches — narrow the pattern or path]`;
      return lines.join("\n");
    },
  });

  const glob = defineTool({
    description:
      "List files matching a glob pattern (`**` supported) inside the working root, powered by ripgrep, sorted by modification time, newest first. Capped at maxResults. Respects .gitignore and skips hidden/.git files by default — set includeIgnored to list everything.",
    inputSchema: z.object({
      pattern: z.string().describe('Glob to match, e.g. "**/*.py" or "src/*.ts"'),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to match in inside the working root; defaults to the working directory",
        ),
      includeIgnored: z
        .boolean()
        .optional()
        .describe("Also list git-ignored and hidden files (still skips .git)"),
      maxResults: z.number().int().min(1).max(1000).default(200),
    }),
    execute: async ({ pattern, path, includeIgnored, maxResults }) => {
      let resolvedPath: string;
      try {
        resolvedPath = resolve(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `ERROR: ${message}`;
      }

      const flags = [
        "--files",
        "--sortr modified",
        includeIgnored ? "--no-ignore --hidden" : "",
        `--glob ${shq(pattern)}`,
        EXCLUDE_GIT,
      ]
        .filter(Boolean)
        .join(" ");
      // cd so ripgrep prints paths relative to the searched directory.
      const cmd = `cd ${shq(resolvedPath)} && ${RG} ${flags} | head -n ${maxResults + 1}`;
      const r = await sb.executeCommand(cmd);
      if (r.exitCode > 1) return `ERROR: ${r.stderr.trim() || `ripgrep exited ${r.exitCode}`}`;
      const lines = r.stdout.split("\n").filter(Boolean);
      if (lines.length === 0)
        return r.stderr.trim() ? `ERROR: ${r.stderr.trim()}` : "No files match.";
      if (lines.length > maxResults)
        return `${lines.slice(0, maxResults).join("\n")}\n[truncated at ${maxResults} files — narrow the pattern]`;
      return lines.join("\n");
    },
  });

  return { grep, glob };
}
