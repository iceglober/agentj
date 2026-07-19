import { describe, expect, mock, test } from "bun:test";
import { ClipboardFilesUnavailableError } from "./clipboard";
import { createCrosscopyClipboardFiles } from "./crosscopy-clipboard-adapter";

describe("createCrosscopyClipboardFiles", () => {
  test("returns copied file paths only when the clipboard has files", async () => {
    const getFiles = mock<() => Promise<string[]>>();
    getFiles.mockResolvedValue(["/tmp/notes.md", "/tmp/plan.md"]);
    const hasFiles = mock(() => true);
    const clipboard = createCrosscopyClipboardFiles({
      load: async () => ({ hasFiles, getFiles }),
    });

    await expect(clipboard.readFiles()).resolves.toEqual(["/tmp/notes.md", "/tmp/plan.md"]);
    expect(hasFiles).toHaveBeenCalledTimes(1);
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  test("does not read text or other clipboard formats", async () => {
    const getFiles = mock<() => Promise<string[]>>();
    const clipboard = createCrosscopyClipboardFiles({
      load: async () => ({ hasFiles: () => false, getFiles }),
    });

    await expect(clipboard.readFiles()).resolves.toEqual([]);
    expect(getFiles).not.toHaveBeenCalled();
  });

  test("redacts native load and clipboard failures", async () => {
    const unavailable = createCrosscopyClipboardFiles({
      load: async () => {
        throw new Error("native clipboard details");
      },
    });
    const failingRead = createCrosscopyClipboardFiles({
      load: async () => ({
        hasFiles: () => true,
        getFiles: async () => {
          throw new Error("copied path details");
        },
      }),
    });

    await expect(unavailable.readFiles()).rejects.toEqual(new ClipboardFilesUnavailableError());
    await expect(failingRead.readFiles()).rejects.toEqual(new ClipboardFilesUnavailableError());
  });
});
