import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPastedImageRegistry,
  expandFileAttachments,
  expandFileReferences,
  formatFileReference,
  formatFileReferences,
} from "./file-attachments";

const createAttachmentDirectory = (): Promise<string> => mkdtemp(path.join(tmpdir(), "agentj-at-"));

describe("file attachments", () => {
  test("attaches referenced files bounded and leaves misses untouched", async () => {
    const cwd = await createAttachmentDirectory();
    try {
      await writeFile(path.join(cwd, "notes.md"), "the notes content");
      const expanded = await expandFileReferences("look at @notes.md and @missing.md", cwd);
      expect(expanded).toContain("--- @notes.md ---");
      expect(expanded).toContain("the notes content");
      expect(expanded).not.toContain("--- @missing.md");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("formats paths unambiguously and expands quoted paths", async () => {
    expect(formatFileReference("src/main.ts")).toBe("@src/main.ts");
    expect(formatFileReferences(["my notes.md", String.raw`C:\Users\me\plan.md`])).toBe(
      String.raw`@"my notes.md" @"C:\\Users\\me\\plan.md"`,
    );

    const cwd = await createAttachmentDirectory();
    try {
      await writeFile(path.join(cwd, 'my "notes".md'), "quoted content");
      const reference = formatFileReference('my "notes".md');
      const expanded = await expandFileReferences(`read ${reference}`, cwd);
      expect(expanded).toContain(`--- ${reference} ---`);
      expect(expanded).toContain("quoted content");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("attaches supported referenced images as base64 instead of UTF-8 text", async () => {
    const cwd = await createAttachmentDirectory();
    try {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await writeFile(path.join(cwd, "screen.png"), png);

      const expanded = await expandFileAttachments("inspect @screen.png", cwd);

      expect(expanded.text).toBe("inspect @screen.png");
      expect(expanded.images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolves only intact pasted-image markers and bounds session storage", () => {
    const images = createPastedImageRegistry();
    const screenshot = { mediaType: "image/png" as const, data: "c2NyZWVuc2hvdA==" };
    const added = images.add(screenshot);
    expect(added).toEqual({ marker: "[pasted image #1]" });
    if ("marker" in added) {
      expect(images.resolve(`inspect ${added.marker}`)).toEqual([screenshot]);
      expect(images.resolve("inspect [pasted image #x]")).toEqual([]);
      expect(images.hasReference(`inspect ${added.marker}`)).toBe(true);
    }
    expect(images.add({ mediaType: "image/png", data: "a".repeat(14_000_000) })).toEqual({
      error: "The pasted image exceeds the 10 MiB limit.",
    });
  });

  test("shares count and content limits across all references", async () => {
    const cwd = await createAttachmentDirectory();
    try {
      await Promise.all(
        Array.from({ length: 17 }, (_, index) =>
          writeFile(path.join(cwd, `file-${index}.md`), "x".repeat(16_384)),
        ),
      );
      const references = Array.from({ length: 17 }, (_, index) => `@file-${index}.md`).join(" ");
      const expanded = await expandFileReferences(references, cwd);
      expect((expanded.match(/--- @file-\d+\.md ---/gu) ?? []).length).toBe(4);
      expect(expanded).not.toContain("--- @file-4.md ---");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
