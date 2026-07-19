import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { ImageAttachment } from "../llm";

const FILE_CONTENT_LIMIT = 16_384;
const FILE_COUNT_LIMIT = 16;
const TOTAL_FILE_CONTENT_LIMIT = 65_536;
const IMAGE_CONTENT_LIMIT = 10 * 1024 * 1024;
const TOTAL_IMAGE_CONTENT_LIMIT = 20 * 1024 * 1024;
const SIMPLE_REFERENCE = /^[\w./~-]+$/u;
const AT_FILE_PATTERN = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([\w./~:\\-]+))/gu;

const imageMediaTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
} as const;

type ImageExtension = keyof typeof imageMediaTypes;

interface FileReference {
  display: string;
  path: string;
}

export interface ExpandedFileAttachments {
  text: string;
  images: ImageAttachment[];
}

export interface PastedImageRegistry {
  add(image: ImageAttachment): { marker: string } | { error: string };
  resolve(text: string): ImageAttachment[];
  hasReference(text: string): boolean;
}

const parseReference = (match: RegExpMatchArray): FileReference | null => {
  const quoted = match[2];
  const unquoted = match[3];
  if (quoted === undefined && unquoted === undefined) return null;
  if (unquoted !== undefined) return { display: unquoted, path: unquoted };
  try {
    const path = JSON.parse(`"${quoted}"`) as unknown;
    return typeof path === "string" ? { display: `"${quoted}"`, path } : null;
  } catch {
    return null;
  }
};

const imageMediaType = (path: string): ImageAttachment["mediaType"] | null => {
  const extension = extname(path).toLowerCase() as ImageExtension;
  return imageMediaTypes[extension] ?? null;
};

/** Formats a path as an unambiguous @file reference for insertion in the editor. */
export const formatFileReference = (path: string): string =>
  `@${SIMPLE_REFERENCE.test(path) ? path : JSON.stringify(path)}`;

/** Formats several paths as editor-ready @file references. */
export const formatFileReferences = (paths: readonly string[]): string =>
  paths.map(formatFileReference).join(" ");

/** A short, editable editor marker for an image held in the current session. */
export const formatPastedImageReference = (index: number): string => `[pasted image #${index}]`;

/** Store bounded image data behind editable markers for one interactive session. */
export const createPastedImageRegistry = (): PastedImageRegistry => {
  const images = new Map<string, ImageAttachment>();
  let counter = 0;
  let totalBytes = 0;
  return {
    add(image) {
      const bytes = Math.floor((image.data.length * 3) / 4);
      if (bytes > IMAGE_CONTENT_LIMIT)
        return { error: "The pasted image exceeds the 10 MiB limit." };
      if (totalBytes + bytes > TOTAL_IMAGE_CONTENT_LIMIT)
        return { error: "Pasted images exceed the 20 MiB session limit." };
      counter += 1;
      totalBytes += bytes;
      const marker = formatPastedImageReference(counter);
      images.set(marker, image);
      return { marker };
    },
    resolve(text) {
      return [...images].flatMap(([marker, image]) => (text.includes(marker) ? [image] : []));
    },
    hasReference(text) {
      return [...images.keys()].some((marker) => text.includes(marker));
    },
  };
};

/** Expand @path references into bounded text and image attachments. */
export async function expandFileAttachments(
  text: string,
  cwd: string,
): Promise<ExpandedFileAttachments> {
  const attachments: string[] = [];
  const images: ImageAttachment[] = [];
  let totalContentLength = 0;
  let totalImageBytes = 0;
  for (const match of text.matchAll(AT_FILE_PATTERN)) {
    if (
      attachments.length + images.length >= FILE_COUNT_LIMIT ||
      (totalContentLength >= TOTAL_FILE_CONTENT_LIMIT &&
        totalImageBytes >= TOTAL_IMAGE_CONTENT_LIMIT)
    )
      break;
    const reference = parseReference(match);
    if (!reference) continue;
    const path = isAbsolute(reference.path) ? reference.path : join(cwd, reference.path);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const mediaType = imageMediaType(path);
      if (mediaType) {
        if (
          info.size > IMAGE_CONTENT_LIMIT ||
          totalImageBytes + info.size > TOTAL_IMAGE_CONTENT_LIMIT
        )
          continue;
        const content = await readFile(path);
        images.push({ mediaType, data: content.toString("base64") });
        totalImageBytes += content.byteLength;
        continue;
      }
      if (totalContentLength >= TOTAL_FILE_CONTENT_LIMIT) continue;
      const remaining = Math.min(FILE_CONTENT_LIMIT, TOTAL_FILE_CONTENT_LIMIT - totalContentLength);
      const content = await readFile(path, "utf8");
      const clipped = content.length > remaining;
      const attached = content.slice(0, remaining);
      totalContentLength += attached.length;
      attachments.push(
        `--- @${reference.display}${clipped ? " (truncated)" : ""} ---\n${attached}`,
      );
    } catch {
      // Not a readable file — leave the mention untouched.
    }
  }
  return { text: attachments.length > 0 ? `${text}\n\n${attachments.join("\n\n")}` : text, images };
}

/** Expand @path and @"path with spaces" references into bounded text blocks. */
export async function expandFileReferences(text: string, cwd: string): Promise<string> {
  return (await expandFileAttachments(text, cwd)).text;
}
