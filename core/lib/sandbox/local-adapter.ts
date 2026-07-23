import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import z from "zod";
import { resolveWithinRoot } from "../tools/paths";
import type { Sandbox } from "./index";

export const localSandboxOptionsSchema = z.object({
  base: z.string().optional(),
  prefix: z.string().default("glorious-local-"),
});

export type LocalSandboxProviderOptions = z.input<typeof localSandboxOptionsSchema>;

export type LocalSandbox = Sandbox & AsyncDisposable & { readonly root: string };

export const createSandboxProviderLocal =
  (options: LocalSandboxProviderOptions = {}) =>
  async (): Promise<LocalSandbox> => {
    const { base, prefix } = localSandboxOptionsSchema.parse(options);
    const parent = path.resolve(base ?? tmpdir());
    await mkdir(parent, { recursive: true });

    const root = await mkdtemp(path.join(parent, prefix));
    let disposed = false;

    return {
      root,
      async executeCommand(command) {
        return await new Promise((resolve, reject) => {
          const child = spawn("bash", ["-lc", command], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";

          child.stdout.on("data", (chunk: string | Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: string | Buffer) => {
            stderr += chunk.toString();
          });

          child.on("error", reject);
          child.on("close", (code) => {
            resolve({
              stdout,
              stderr,
              exitCode: code ?? 1,
            });
          });
        });
      },
      async readFile(candidate) {
        return await readFile(resolveWithinRoot(root, candidate), "utf8");
      },
      async writeFiles(files) {
        for (const file of files) {
          const target = resolveWithinRoot(root, file.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
      },
      async [Symbol.asyncDispose]() {
        if (disposed) return;
        disposed = true;
        await rm(root, { recursive: true, force: true });
      },
    };
  };
