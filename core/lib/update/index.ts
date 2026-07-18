import z from "zod";

export const updateChannels = ["auto", "next", "latest"] as const;
export const updateChannelSchema = z.enum(updateChannels);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const updateConfigSchema = z
  .object({
    channel: updateChannelSchema.default("auto"),
    package: z.string().min(1).default("@glrs-dev/aj"),
    checkIntervalMs: z.number().int().min(0).default(24 * 60 * 60 * 1000),
  })
  .prefault({});
export type UpdateConfig = z.infer<typeof updateConfigSchema>;

export interface UpdateRegistry {
  latest(packageName: string, tag: "next" | "latest"): Promise<string | undefined>;
}
export interface UpdateInstaller {
  install(packageName: string, tag: "next" | "latest"): Promise<void>;
}
export interface UpdateResult {
  current: string;
  available?: string;
  channel: "next" | "latest";
}
export interface UpdateService {
  check(current: string): Promise<UpdateResult>;
  install(): Promise<void>;
}

function versionParts(version: string): number[] {
  const match = version.replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : [];
}
function newer(candidate: string, current: string): boolean {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a.length || !b.length) return candidate !== current;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export function createUpdateService(
  config: UpdateConfig,
  ports: { registry: UpdateRegistry; installer?: UpdateInstaller },
  now: () => number = Date.now,
): UpdateService {
  const channel = config.channel === "auto" ? "next" : config.channel;
  let cached: { at: number; result: UpdateResult } | undefined;
  return {
    async check(current) {
      if (cached && now() - cached.at < config.checkIntervalMs && cached.result.current === current)
        return cached.result;
      const available = await ports.registry.latest(config.package, channel);
      const result = { current, ...(available && newer(available, current) ? { available } : {}), channel };
      cached = { at: now(), result };
      return result;
    },
    async install() {
      if (!ports.installer) throw new Error("Update installation is unavailable.");
      await ports.installer.install(config.package, channel);
      cached = undefined;
    },
  };
}
