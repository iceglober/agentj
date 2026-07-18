import { spawn } from "node:child_process";
import type { UpdateInstaller, UpdateRegistry } from "./index";

type CommandResult = { stdout: string; stderr: string; exitCode: number };
export interface NpmAdapterOptions {
  fetchImpl?: typeof fetch;
  command?: (file: string, args: readonly string[]) => Promise<CommandResult>;
  platform?: NodeJS.Platform;
}

async function run(file: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

export function createNpmRegistryAdapter(options: NpmAdapterOptions = {}): UpdateRegistry {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async latest(packageName, tag) {
      const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${tag}`;
      const response = await fetchImpl(url);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : undefined;
    },
  };
}

export function detectPackageManager(platform: NodeJS.Platform = process.platform): "bun" | "npm" {
  return platform === "win32" ? "npm" : "bun";
}

export function createNpmInstaller(options: NpmAdapterOptions = {}): UpdateInstaller {
  const command = options.command ?? run;
  return {
    async install(packageName, tag) {
      const manager = detectPackageManager(options.platform);
      const result = await command(manager, ["add", "-g", `${packageName}@${tag}`]);
      if (result.exitCode !== 0)
        throw new Error(`Unable to install update with ${manager}: ${result.stderr.trim()}`);
    },
  };
}

export function createNpmUpdateAdapters(options: NpmAdapterOptions = {}) {
  return { registry: createNpmRegistryAdapter(options), installer: createNpmInstaller(options) };
}
