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
  const refreshCache = async (current: string, channel: ReleaseChannel): Promise<UpdateResult> => {
    const available = await options.registry.latest(options.packageName, channel);
    const result = {
      current,
      channel,
      ...(available && available !== current ? { available } : {}),
    };
    await options.state?.write({ ...result, checkedAt: now() });
    return result;
  };
  const check = async (
    current: string,
    requested: UpdateChannel = options.config.channel,
    refresh = false,
  ): Promise<UpdateResult> => {
    const channel = resolveUpdateChannel(current, requested);
    const cached = await options.state?.read();
    if (
      !refresh &&
      cached &&
      cached.current === current &&
      cached.channel === channel &&
      now() - cached.checkedAt < checkIntervalMs
    ) {
      // Stale-while-revalidate: the cached "no update" stays authoritative for
      // this call so launches never wait on the registry, while a background
      // refresh rewrites the cache so the NEXT launch acts on releases
      // published since the cache was written. A cache that already carries
      // `available` skips this — the caller is about to install and refresh.
      if (!cached.available) void refreshCache(current, channel).catch(() => undefined);
      return cached;
    }
    return refreshCache(current, channel);
  };

  return {
    check,
    async update(current, requested) {
      // An explicit update must check the registry now, rather than reporting
      // a stale cached result as current for up to the normal check interval.
      const result = await check(current, requested, true);
      if (!result.available) return result;
      if (!options.installer)
        throw new Error("This AgentJ installation cannot be updated automatically.");
      await options.installer.install(options.packageName, result.channel);
      return result;
    },
  };
}
