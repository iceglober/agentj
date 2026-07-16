import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnvironment } from ".";

export type HostExecutionEnvironment = ExecutionEnvironment &
  AsyncDisposable & { readonly root: string };

export async function createHostExecutionEnvironment(
  root: string,
): Promise<HostExecutionEnvironment> {
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
        child.stdout.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
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
