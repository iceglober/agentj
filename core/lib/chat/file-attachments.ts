import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const FILE_CONTENT_LIMIT = 16_384;
const FILE_COUNT_LIMIT = 16;
const TOTAL_FILE_CONTENT_LIMIT = 65_536;
const SIMPLE_REFERENCE = /^[\w./~-]+$/u;
const AT_FILE_PATTERN = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([\w./~:\\-]+))/gu;

interface FileReference {
  display: string;
  path: string;
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

/** Formats a path as an unambiguous @file reference for insertion in the editor. */
export const formatFileReference = (path: string): string =>
  `@${SIMPLE_REFERENCE.test(path) ? path : JSON.stringify(path)}`;

/** Formats several paths as editor-ready @file references. */
export const formatFileReferences = (paths: readonly string[]): string =>
  paths.map(formatFileReference).join(" ");

/** Expand @path and @"path with spaces" references into bounded attachment blocks. */
export async function expandFileReferences(text: string, cwd: string): Promise<string> {
  const attachments: string[] = [];
  let totalContentLength = 0;
  for (const match of text.matchAll(AT_FILE_PATTERN)) {
    if (attachments.length >= FILE_COUNT_LIMIT || totalContentLength >= TOTAL_FILE_CONTENT_LIMIT)
      break;
    const reference = parseReference(match);
    if (!reference) continue;
    const path = isAbsolute(reference.path) ? reference.path : join(cwd, reference.path);
    try {
      if (!(await stat(path)).isFile()) continue;
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
  return attachments.length > 0 ? `${text}\n\n${attachments.join("\n\n")}` : text;
}
