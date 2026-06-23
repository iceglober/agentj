// The agent's hands: primitive tools as AI SDK `tool()` objects. v1 runs on the host,
// rooted at `root`; file tools are confined to it via safeResolve. Output is truncated
// *inside* execute so noisy results don't bloat context. Tools never throw — they return
// a string the model can act on.
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { safeResolve } from "../tools/index.ts";

export interface ToolDeps {
  /** Repository root; everything is relative to it. */
  root: string;
  /** Aborts in-flight bash when the run is cancelled. */
  signal?: AbortSignal;
}

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

export function makeTools(deps: ToolDeps): ToolSet {
  const { root, signal } = deps;

  return {
    read_file: tool({
      description: "Read a UTF-8 text file, relative to the repo root.",
      parameters: z.object({ path: z.string().describe("File path relative to the repo root") }),
      execute: async ({ path }) => {
        try {
          const abs = safeResolve(root, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return `file not found: ${path}`;
          const buf = new Uint8Array(await file.arrayBuffer());
          if (buf.subarray(0, 8000).includes(0)) return `[binary file, ${buf.length} bytes, not shown]`;
          return clip(new TextDecoder().decode(buf), 200_000) || "(empty file)";
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),

    write_file: tool({
      description: "Create or overwrite a file with the given content.",
      parameters: z.object({
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
      parameters: z.object({
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
      parameters: z.object({ path: z.string().optional().describe("Directory path; defaults to the repo root") }),
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

    grep: tool({
      description: "Search file contents with a regex, from the repo root. Returns matching lines with line numbers.",
      parameters: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Path to search within; defaults to the whole repo"),
      }),
      execute: async ({ pattern, path }) => {
        const where = path ?? ".";
        const runRg = async () => {
          const proc = Bun.spawn({
            cmd: ["rg", "--line-number", "--no-heading", "--color", "never", pattern, where],
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          return { out, code };
        };
        try {
          let out: string;
          let code: number;
          try {
            ({ out, code } = await runRg());
          } catch {
            // ripgrep not installed — fall back to git grep.
            const proc = Bun.spawn({
              cmd: ["git", "grep", "-n", "-E", pattern, "--", where],
              cwd: root,
              stdout: "pipe",
              stderr: "pipe",
            });
            [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
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
      parameters: z.object({ command: z.string().describe("Shell command to run") }),
      execute: async ({ command }) => {
        try {
          const proc = Bun.spawn({
            cmd: ["bash", "-lc", command],
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          });
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, BASH_TIMEOUT_MS);
          const onAbort = () => proc.kill();
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            const [out, err, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            const body = headTail([out, err].filter(Boolean).join("\n").trimEnd());
            const note = timedOut ? `\n[timed out after ${BASH_TIMEOUT_MS / 1000}s]` : "";
            return `${body}\n[exit ${code}]${note}`.trim();
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          }
        } catch (err) {
          return `error: ${asMessage(err)}`;
        }
      },
    }),
  };
}
