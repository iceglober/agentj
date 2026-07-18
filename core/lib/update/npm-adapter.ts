import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReleaseChannel, UpdateInstaller, UpdateRegistry, UpdateStateStore } from "./index";

type CommandResult = { stderr: string; exitCode: number };
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NpmAdapterOptions {
  fetchImpl?: Fetch;
  command?: (file: string, args: readonly string[]) => Promise<CommandResult>;
  packageRoot?: string;
  cachePath?: string;
}

const run = async (file: string, args: readonly string[]): Promise<CommandResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stderr, exitCode: exitCode ?? 1 }));
  });

export const detectPackageManager = (packageRoot: string): "bun" | "npm" | undefined => {
  const normalized = packageRoot.replaceAll("\\", "/");
  if (normalized.includes("/.bun/install/global/node_modules/")) return "bun";
  if (normalized.includes("/node_modules/")) return "npm";
  return undefined;
};

export function createNpmRegistryAdapter(fetchImpl: Fetch = fetch): UpdateRegistry {
  return {
    async latest(packageName, channel) {
      const response = await fetchImpl(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${channel}`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : undefined;
    },
  };
}

export function createNpmInstaller(options: NpmAdapterOptions): UpdateInstaller | undefined {
  const manager = options.packageRoot ? detectPackageManager(options.packageRoot) : undefined;
  if (!manager) return undefined;
  const command = options.command ?? run;
  return {
    async install(packageName: string, channel: ReleaseChannel) {
      const args =
        manager === "bun"
          ? ["add", "--global", `${packageName}@${channel}`]
          : ["install", "--global", `${packageName}@${channel}`];
      const result = await command(manager, args);
      if (result.exitCode !== 0) {
        throw new Error(
          `Unable to install update with ${manager}: ${result.stderr.trim() || "unknown error"}`,
        );
      }
    },
  };
}

export function createUpdateStateStore(
  cachePath = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "agentj",
    "update.json",
  ),
): UpdateStateStore {
  return {
    async read() {
      try {
        const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { checkedAt?: unknown }).checkedAt === "number" &&
          typeof (value as { current?: unknown }).current === "string" &&
          ((value as { channel?: unknown }).channel === "next" ||
            (value as { channel?: unknown }).channel === "latest")
        )
          return value as Awaited<ReturnType<UpdateStateStore["read"]>>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      return undefined;
    },
    async write(cache) {
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
      await rename(temporary, cachePath);
    },
  };
}
