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
    async executeCommand(command) {
      return await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-lc", command], {
          cwd: canonicalRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, commandTimeoutMs);
        timer.unref();
        child.stdout.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            stdout,
            stderr: timedOut
              ? `${stderr}\n[command timed out after ${Math.round(commandTimeoutMs / 1000)}s and was killed]`
              : stderr,
            exitCode: timedOut ? 124 : (code ?? 1),
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
