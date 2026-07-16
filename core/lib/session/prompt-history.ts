import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAX_ENTRIES = 100;

interface PromptHistoryRecord {
  type: "prompt";
  text: string;
}

export interface PromptHistory {
  readonly path: string;
  readonly entries: readonly string[];
  append(text: string): Promise<void>;
}

export interface CreatePromptHistoryOptions {
  /** History root, e.g. `$XDG_STATE_HOME/agentj/prompt-history`. */
  root: string;
  /** Canonical common Git directory so every worktree shares one history. */
  projectIdentity: string;
  maxEntries?: number;
}

const historyFileName = (projectIdentity: string): string =>
  `${createHash("sha256").update(projectIdentity).digest("hex").slice(0, 16)}.jsonl`;

const parseEntries = (text: string, maxEntries: number): string[] => {
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<PromptHistoryRecord>;
      if (record.type !== "prompt" || typeof record.text !== "string" || !record.text.trim()) {
        continue;
      }
      if (entries.at(-1) !== record.text) entries.push(record.text);
    } catch {
      // Ignore malformed records, including a torn final write.
    }
  }
  return entries.slice(-maxEntries);
};

export async function createPromptHistory(
  options: CreatePromptHistoryOptions,
): Promise<PromptHistory> {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const path = join(options.root, historyFileName(options.projectIdentity));

  let persisted = "";
  try {
    persisted = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const entries = parseEntries(persisted, maxEntries);
  let writes = Promise.resolve();

  return {
    path,
    get entries() {
      return [...entries];
    },
    append(text) {
      if (!text.trim() || entries.at(-1) === text) return Promise.resolve();
      entries.push(text);
      if (entries.length > maxEntries) entries.shift();

      const write = writes.then(() =>
        appendFile(path, `${JSON.stringify({ type: "prompt", text })}\n`, { mode: 0o600 }),
      );
      writes = write.catch(() => {});
      return write;
    },
  };
}
