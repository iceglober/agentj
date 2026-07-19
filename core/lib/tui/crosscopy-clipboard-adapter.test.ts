import { describe, expect, mock, test } from "bun:test";
import { ClipboardAttachmentsUnavailableError } from "./clipboard";
import { createCrosscopyClipboardAttachments } from "./crosscopy-clipboard-adapter";

describe("createCrosscopyClipboardAttachments", () => {
  test("returns copied file paths before any image format", async () => {
    const getFiles = mock<() => Promise<string[]>>();
    getFiles.mockResolvedValue(["/tmp/notes.md", "/tmp/plan.md"]);
    const hasFiles = mock(() => true);
    const getImageBase64 = mock<() => Promise<string>>();
    const clipboard = createCrosscopyClipboardAttachments({
      load: async () => ({ hasFiles, getFiles, hasImage: () => true, getImageBase64 }),
    });

    await expect(clipboard.read()).resolves.toEqual({
      kind: "files",
      paths: ["/tmp/notes.md", "/tmp/plan.md"],
    });
    expect(hasFiles).toHaveBeenCalledTimes(1);
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(getImageBase64).not.toHaveBeenCalled();
  });

  test("returns copied PNG image data when the clipboard has no files", async () => {
    const getImageBase64 = mock<() => Promise<string>>();
    getImageBase64.mockResolvedValue("c2NyZWVuc2hvdA==");
    const clipboard = createCrosscopyClipboardAttachments({
      load: async () => ({
        hasFiles: () => false,
        getFiles: async () => [],
        hasImage: () => true,
        getImageBase64,
      }),
    });

    await expect(clipboard.read()).resolves.toEqual({
      kind: "image",
      image: { mediaType: "image/png", data: "c2NyZWVuc2hvdA==" },
    });
  });

  test("does not read text or other clipboard formats", async () => {
    const getImageBase64 = mock<() => Promise<string>>();
    const clipboard = createCrosscopyClipboardAttachments({
      load: async () => ({
        hasFiles: () => false,
        getFiles: async () => [],
        hasImage: () => false,
        getImageBase64,
      }),
    });

    await expect(clipboard.read()).resolves.toBeNull();
    expect(getImageBase64).not.toHaveBeenCalled();
  });

  test("redacts native load and clipboard failures", async () => {
    const unavailable = createCrosscopyClipboardAttachments({
      load: async () => {
        throw new Error("native clipboard details");
      },
    });
    const failingRead = createCrosscopyClipboardAttachments({
      load: async () => ({
        hasFiles: () => false,
        getFiles: async () => [],
        hasImage: () => true,
        getImageBase64: async () => {
          throw new Error("copied image details");
        },
      }),
    });

    await expect(unavailable.read()).rejects.toEqual(new ClipboardAttachmentsUnavailableError());
    await expect(failingRead.read()).rejects.toEqual(new ClipboardAttachmentsUnavailableError());
  });
});
