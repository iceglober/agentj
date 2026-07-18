import z from "zod";

export const updateChannels = ["auto", "next", "latest"] as const;
export const updateChannelSchema = z.enum(updateChannels);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export type ReleaseChannel = Exclude<UpdateChannel, "auto">;

/** Update policy is owned here; config/index.ts only composes it. */
export const updateConfigSchema = z
  .object({
    auto: z.boolean().default(true),
    channel: updateChannelSchema.default("auto"),
  })
  .prefault({});
export type UpdateConfig = z.infer<typeof updateConfigSchema>;

export interface UpdateCache {
  checkedAt: number;
  current: string;
  channel: ReleaseChannel;
  available?: string;
}

export interface UpdateRegistry {
  latest(packageName: string, channel: ReleaseChannel): Promise<string | undefined>;
}

export interface UpdateInstaller {
  install(packageName: string, channel: ReleaseChannel): Promise<void>;
}

export interface UpdateStateStore {
  read(): Promise<UpdateCache | undefined>;
  write(cache: UpdateCache): Promise<void>;
}

export interface UpdateResult {
  current: string;
  channel: ReleaseChannel;
  available?: string;
}

export interface UpdateService {
  check(current: string, channel?: UpdateChannel): Promise<UpdateResult>;
  update(current: string, channel?: UpdateChannel): Promise<UpdateResult>;
}

export const resolveUpdateChannel = (
  current: string,
  requested: UpdateChannel = "auto",
): ReleaseChannel =>
  requested === "auto" ? (current.includes("-") ? "next" : "latest") : requested;

export function createUpdateService(options: {
  config: UpdateConfig;
  packageName: string;
  registry: UpdateRegistry;
  installer?: UpdateInstaller;
  state?: UpdateStateStore;
  now?: () => number;
  checkIntervalMs?: number;
}): UpdateService {
  const now = options.now ?? Date.now;
  const checkIntervalMs = options.checkIntervalMs ?? 24 * 60 * 60 * 1000;
  const check = async (
    current: string,
    requested: UpdateChannel = options.config.channel,
  ): Promise<UpdateResult> => {
    const channel = resolveUpdateChannel(current, requested);
    const cached = await options.state?.read();
    if (
      cached &&
      cached.current === current &&
      cached.channel === channel &&
      now() - cached.checkedAt < checkIntervalMs
    ) {
      return cached;
    }
    const available = await options.registry.latest(options.packageName, channel);
    const result = {
      current,
      channel,
      ...(available && available !== current ? { available } : {}),
    };
    await options.state?.write({ ...result, checkedAt: now() });
    return result;
  };

  return {
    check,
    async update(current, requested) {
      const result = await check(current, requested);
      if (!result.available) return result;
      if (!options.installer)
        throw new Error("This AgentJ installation cannot be updated automatically.");
      await options.installer.install(options.packageName, result.channel);
      return result;
    },
  };
}
