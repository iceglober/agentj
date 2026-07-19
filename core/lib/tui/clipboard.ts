import type { ImageAttachment } from "../llm";

/** An attachment copied through the operating system clipboard. */
export type ClipboardAttachment =
  | { kind: "files"; paths: readonly string[] }
  | { kind: "image"; image: ImageAttachment };

export interface ClipboardAttachments {
  read(): Promise<ClipboardAttachment | null>;
}

/** The OS clipboard cannot supply attachments on this host. */
export class ClipboardAttachmentsUnavailableError extends Error {
  constructor() {
    super("Copied attachments are unavailable from the system clipboard.");
    this.name = "ClipboardAttachmentsUnavailableError";
  }
}
