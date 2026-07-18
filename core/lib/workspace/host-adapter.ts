import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnvironment } from ".";

export type HostExecutionEnvironment = ExecutionEnvironment &
  AsyncDisposable & { readonly root: string };

/** Commands that outlive this are killed (SIGTERM, then SIGKILL): nothing on
 *  the host may pend a tool call forever — a wedged command becomes a visible
 *  nonzero result the model (and the user) can react to. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export async function createHostExecutionEnvironment(
  root: string,
  options: { commandTimeoutMs?: number } = {},
): Promise<HostExecutionEnvironment> {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new Error("Host workspace is not a directory.");

  return {
    root: canonicalRoot,
    async executeCommand(command, options) {
      return await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-lc", command], {
          cwd: canonicalRoot,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group: compound commands (`a && b`) fork children that
          // inherit the stdio pipes, and killing only the parent bash leaves an
          // orphan holding them open — `close` then waits out the orphan.
          detached: true,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        const kill = (signal: NodeJS.Signals): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            // The group is already gone.
          }
        };
        const terminate = (): void => {
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5_000).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, commandTimeoutMs);
        timer.unref();
        // An interrupt (Esc) kills the command the same way a timeout does:
        // the tool call settles with a visible nonzero result instead of
        // pending until the command finishes on its own.
        const onAbort = (): void => {
          aborted = true;
          terminate();
        };
        const signal = options?.signal;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const note = aborted
            ? "\n[command interrupted and killed]"
            : timedOut
              ? `\n[command timed out after ${Math.round(commandTimeoutMs / 1000)}s and was killed]`
              : "";
          resolve({
            stdout,
            stderr: `${stderr}${note}`,
            exitCode: aborted ? 130 : timedOut ? 124 : (code ?? 1),
          });
        });
      });
    },
    readFile: (candidate) => readFile(path.resolve(canonicalRoot, candidate), "utf8"),
    async writeFiles(files) {
      for (const file of files) {
        const target = path.resolve(canonicalRoot, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    },
    async [Symbol.asyncDispose]() {},
  };
}
