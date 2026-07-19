import {
  type ClipboardAttachment,
  type ClipboardAttachments,
  ClipboardAttachmentsUnavailableError,
} from "./clipboard";

export interface CrosscopyClipboard {
  hasFiles(): boolean;
  getFiles(): Promise<string[]>;
  hasImage(): boolean;
  getImageBase64(): Promise<string>;
}

export type CrosscopyClipboardLoader = () => Promise<CrosscopyClipboard>;

const loadCrosscopyClipboard: CrosscopyClipboardLoader = async () =>
  import("@crosscopy/clipboard") as Promise<CrosscopyClipboard>;

/**
 * Reads copied local paths or PNG images through CrossCopy. The native module
 * stays lazy so unsupported systems can still start Agentj and report a safe
 * error on paste.
 */
export function createCrosscopyClipboardAttachments({
  load = loadCrosscopyClipboard,
}: {
  load?: CrosscopyClipboardLoader;
} = {}): ClipboardAttachments {
  return {
    async read(): Promise<ClipboardAttachment | null> {
      try {
        const clipboard = await load();
        if (clipboard.hasFiles()) return { kind: "files", paths: await clipboard.getFiles() };
        if (clipboard.hasImage()) {
          const data = await clipboard.getImageBase64();
          return data ? { kind: "image", image: { mediaType: "image/png", data } } : null;
        }
        return null;
      } catch {
        throw new ClipboardAttachmentsUnavailableError();
      }
    },
  };
}
