/** Local file paths copied through the operating system clipboard. */
export interface ClipboardFiles {
  readFiles(): Promise<readonly string[]>;
}

/** The OS clipboard cannot supply copied files on this host. */
export class ClipboardFilesUnavailableError extends Error {
  constructor() {
    super("Copied files are unavailable from the system clipboard.");
    this.name = "ClipboardFilesUnavailableError";
  }
}
