import { type ClipboardFiles, ClipboardFilesUnavailableError } from "./clipboard";

export interface CrosscopyClipboard {
  hasFiles(): boolean;
  getFiles(): Promise<string[]>;
}

export type CrosscopyClipboardLoader = () => Promise<CrosscopyClipboard>;

const loadCrosscopyClipboard: CrosscopyClipboardLoader = async () =>
  import("@crosscopy/clipboard") as Promise<CrosscopyClipboard>;

/**
 * Reads copied local paths through CrossCopy. The native module stays lazy so
 * unsupported systems can still start Agentj and report a safe error on paste.
 */
export function createCrosscopyClipboardFiles({
  load = loadCrosscopyClipboard,
}: {
  load?: CrosscopyClipboardLoader;
} = {}): ClipboardFiles {
  return {
    async readFiles() {
      try {
        const clipboard = await load();
        if (!clipboard.hasFiles()) return [];
        return await clipboard.getFiles();
      } catch {
        throw new ClipboardFilesUnavailableError();
      }
    },
  };
}
