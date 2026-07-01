// The agent's hands: file + exec primitives as AI SDK `tool()` objects. They run on the host, rooted
// at `root`; file tools are confined to it via safeResolve. Output is truncated INSIDE execute so a
// noisy result doesn't bloat context. Tools never throw — they return a string the model can act on.
// Permissions are auto: every call proceeds (the user owns git as the safety net).
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, resolve as pathResolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { run } from "./exec.ts";

const BASH_TIMEOUT_MS = 120_000;

/** Keep head + tail of long output, dropping the middle. */
function headTail(text: string, head = 4000, tail = 2000): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(-tail)}`;
}

/** Hard char cap with a trailing note. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated, ${text.length - max} more chars]`;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Is `candidate` the root or strictly inside it (prefix match on a trailing-slashed root)? */
function isInside(root: string, candidate: string): boolean {
  const norm = root.endsWith("/") ? root : `${root}/`;
  return candidate === root || candidate.startsWith(norm);
}

/**
 * Resolve `relPath` against `root` and confine it there. Resolves symlinks (realpath) on the deepest
 * existing ancestor, then re-appends the non-existent tail — so a symlink pointing outside the repo,
 * or a `../` escape, is rejected even when the target file doesn't exist yet (write_file).
 */
function safeResolve(root: string, relPath: string): string {
  const realRoot = realpathSync(root);
  const abs = pathResolve(realRoot, relPath);
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  const finalPath = tail.length ? pathResolve(realExisting, ...tail) : realExisting;
  if (!isInside(realRoot, finalPath)) throw new Error(`path escapes the repo root: ${relPath}`);
  return finalPath;
}

/**
 * The repo's non-ignored files (tracked + untracked-not-ignored), so glob respects .gitignore without
 * re-implementing it. Returns null when `root` isn't a git repo, so glob can fall back to an fs walk.
 */
async function listRepoFiles(root: string): Promise<string[] | null> {
  try {
    const r = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
    return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : null;
  } catch {
    return null; // git not installed
  }
}

export interface ToolDeps {
  /** Repository root; everything is relative to it. */
  root: string;
  /** Aborts in-flight bash/grep when the turn is cancelled (Ctrl-C). */
  signal?: AbortSignal;
}

export function makeTools(deps: ToolDeps): ToolSet {
  const { root, signal } = deps;

  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file (relative to repo root), returned with line numbers. Large files " +
        "are truncated to keep context small — pass offset/limit (1-based line range) to read a " +
        "specific span. Read only the part you need; grep first to find the right lines.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        offset: z.number().optional().describe("1-based first line to return (default 1)"),
        limit: z.number().optional().describe("Max lines to return (default 400, ceiling 1200)"),
      }),
      execute: async ({ path, offset, limit }) => {
        try {
          const abs = safeResolve(root, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return `file not found: ${path}`;
          const buf = new Uint8Array(await file.arrayBuffer());
          if (buf.length === 0) return "(empty file)";
          if (buf.subarray(0, 8000).includes(0)) return `[binary file, ${buf.length} bytes, not shown]`;
          const lines = new TextDecoder().decode(buf).split("\n");
          const total = lines.length;
          const start = Math.max(1, offset ?? 1);
          const span = Math.max(1, Math.min(limit ?? 400, 1200));
          const slice = lines.slice(start - 1, start - 1 + span);
          if (slice.length === 0) return `${path}: ${total} lines; offset ${start} is past the end`;
          const end = start - 1 + slice.length;
          const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
          const note = start > 1 || end < total ? `\n[lines ${start}–${end} of ${total}; pass offset/limit for more]` : "";
          return clip(numbered, 40_000) + note;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    write_file: tool({
      description: "Create or overwrite a file with the given content.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        content: z.string().describe("Full file content to write"),
      }),
      execute: async ({ path, content }) => {
        try {
          const abs = safeResolve(root, path);
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, content);
          return `wrote ${content.length} bytes to ${path}`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    edit_file: tool({
      description: "Replace an exact, unique string in a file. old_string must occur exactly once.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root"),
        old_string: z.string().describe("Exact text to replace (must be unique in the file)"),
        new_string: z.string().describe("Replacement text"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        try {
          const abs = safeResolve(root, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return `file not found: ${path}`;
          const text = await file.text();
          const count = text.split(old_string).length - 1;
          if (count === 0) return `old_string not found in ${path}`;
          if (count > 1) return `old_string is not unique in ${path} (${count} matches) — add more context`;
          await Bun.write(abs, text.replace(old_string, new_string));
          return `edited ${path}`;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    list_dir: tool({
      description: "List the entries of a directory (relative to the repo root). Directories end with /.",
      inputSchema: z.object({ path: z.string().optional().describe("Directory path; defaults to the repo root") }),
      execute: async ({ path }) => {
        try {
          const abs = safeResolve(root, path ?? ".");
          const entries = await readdir(abs, { withFileTypes: true });
          const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
          return clip(names.join("\n"), 8000) || "(empty)";
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    glob: tool({
      description:
        "Find files by glob pattern, relative to the repo root (e.g. '**/*.ts', 'src/**/README*'). " +
        "A pattern with no slash matches at any depth ('*.ts' → all .ts files; 'README*' → every " +
        "README). Respects .gitignore. Prefer this over walking the tree with list_dir to locate a " +
        "file by name.",
      inputSchema: z.object({ pattern: z.string().describe("Glob pattern, relative to the repo root") }),
      execute: async ({ pattern }) => {
        if (pattern.startsWith("/") || pattern.split("/").includes("..")) {
          return "error: pattern must stay within the repo (no leading / or '..')";
        }
        const norm = pattern.includes("/") ? pattern : `**/${pattern}`;
        try {
          const g = new Bun.Glob(norm);
          const tracked = await listRepoFiles(root);
          let hits: string[];
          if (tracked) {
            hits = tracked.filter((f) => g.match(f));
          } else {
            // Not a git repo — walk the filesystem, skipping the usual noise.
            hits = [];
            for await (const f of g.scan({ cwd: root, onlyFiles: true, dot: true })) {
              if (!f.startsWith("node_modules/") && !f.startsWith(".git/")) hits.push(f);
            }
          }
          hits.sort();
          if (hits.length === 0) return "no matches";
          const shown = hits.slice(0, 100).join("\n");
          return shown + (hits.length > 100 ? `\n… (+${hits.length - 100} more)` : "");
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    grep: tool({
      description: "Search file contents with a regex, from the repo root. Returns matching lines with line numbers.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Path to search within; defaults to the whole repo"),
      }),
      execute: async ({ pattern, path }) => {
        const where = path ?? ".";
        try {
          safeResolve(root, where); // confine the search path (reject ../ + symlink escapes)
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
        try {
          let out: string;
          let code: number;
          try {
            const r = await run(["rg", "--line-number", "--no-heading", "--color", "never", pattern, where], { cwd: root, signal });
            out = r.stdout;
            code = r.exitCode;
          } catch {
            // ripgrep not installed — fall back to git grep.
            const r = await run(["git", "grep", "-n", "-E", pattern, "--", where], { cwd: root, signal });
            out = r.stdout;
            code = r.exitCode;
          }
          if (code === 1 || out.trim() === "") return "no matches";
          const lines = out.split("\n").filter(Boolean);
          const shown = lines.slice(0, 50).join("\n");
          const more = lines.length > 50 ? `\n… (+${lines.length - 50} more matches)` : "";
          return shown + more;
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    bash: tool({
      description:
        "Run a shell command from the repo root (bash -lc). Use for builds, tests, git, etc. Output is truncated; bounded to 120s.",
      inputSchema: z.object({ command: z.string().describe("Shell command to run") }),
      execute: async ({ command }) => {
        try {
          const { stdout, stderr, exitCode, timedOut } = await run(["bash", "-lc", command], {
            cwd: root,
            signal,
            timeoutMs: BASH_TIMEOUT_MS,
          });
          const raw = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
          const note = timedOut ? `\n[timed out after ${BASH_TIMEOUT_MS / 1000}s]` : "";
          return `${headTail(raw)}\n[exit ${exitCode}]${note}`.trim();
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),
  };
}
