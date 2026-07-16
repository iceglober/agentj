import type { Sandbox } from ".";
import {
  createSandboxProviderMicrosandbox,
  type MicrosandboxProviderOptions,
} from "./microsandbox-adapter";

export interface SandboxAdapter<Config = unknown> {
  create(config: Config): Promise<Sandbox & AsyncDisposable>;
  reconnect?(providerSessionId: string): Promise<(Sandbox & AsyncDisposable) | null>;
}

export const sandboxAdapters = {
  microsandbox: {
    create: (config: MicrosandboxProviderOptions) => createSandboxProviderMicrosandbox(config)(),
  } satisfies SandboxAdapter<MicrosandboxProviderOptions>,
};

export type SandboxProviderName = keyof typeof sandboxAdapters;
