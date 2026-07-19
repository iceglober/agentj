import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The single persistence story for chat sessions: one append-only JSONL file
 * per session at `<root>/<projectHash>/<id>.jsonl`. `turn` records are the
 * renderable history; `state` records carry the opaque runtime continuation
 * (last one wins on load). Crash-safe by construction — a torn tail line is
 * skipped, everything before it is intact.
 */

export type ChatMode = "plan" | "build";

export type ChatLogRecord =
  | { type: "meta"; id: string; projectRoot: string; createdAt: string; title: string }
  | {
      type: "turn";
      mode: ChatMode;
      user: string;
      assistant: string;
      ts: string;
      transcriptText?: string;
    }
  | { type: "state"; messages: unknown[]; mode: ChatMode; ts: string }
  | {
      type: "usage";
      provider: string;
      model: string;
      ts: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
        longContextRequests: number;
      };
    }
  | { type: "undo"; ref: string; label: string; ts: string };

export interface LoadedChatLog {
  meta: Extract<ChatLogRecord, { type: "meta" }>;
  turns: Extract<ChatLogRecord, { type: "turn" }>[];
  /** Per-turn foreground usage, retained for resumed cost reporting. */
  usage: Extract<ChatLogRecord, { type: "usage" }>[];
  /** The resumable continuation — the last `state` record, if any. */
  state: Extract<ChatLogRecord, { type: "state" }> | null;
}

export interface ChatLog {
  readonly id: string;
  readonly path: string;
  append(record: ChatLogRecord): Promise<void>;
}

const projectHash = (projectRoot: string): string =>
  createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);

const projectDir = (root: string, projectRoot: string): string =>
  join(root, projectHash(projectRoot));

export interface CreateChatLogOptions {
  /** Session-log root, e.g. `$XDG_STATE_HOME/agentj/chats` (caller resolves). */
  root: string;
  projectRoot: string;
  id?: string;
  title?: string;
}

export async function createChatLog(options: CreateChatLogOptions): Promise<ChatLog> {
  const id = options.id ?? crypto.randomUUID().slice(0, 8);
  const dir = projectDir(options.root, options.projectRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.jsonl`);

  const log: ChatLog = {
    id,
    path,
    async append(record) {
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  };
  await log.append({
    type: "meta",
    id,
    projectRoot: options.projectRoot,
    createdAt: new Date().toISOString(),
    title: (options.title ?? "").slice(0, 80),
  });
  return log;
}

export async function loadChatLog(options: {
  root: string;
  projectRoot: string;
  id: string;
}): Promise<LoadedChatLog | null> {
  const path = join(projectDir(options.root, options.projectRoot), `${options.id}.jsonl`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let meta: LoadedChatLog["meta"] | null = null;
  const turns: LoadedChatLog["turns"] = [];
  const usage: LoadedChatLog["usage"] = [];
  let state: LoadedChatLog["state"] = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: ChatLogRecord;
    try {
      record = JSON.parse(line) as ChatLogRecord;
    } catch {
      continue; // torn tail line from a crash — everything before it is intact
    }
    if (record.type === "meta") meta ??= record;
    else if (record.type === "turn") turns.push(record);
    else if (record.type === "usage") usage.push(record);
    else if (record.type === "state") state = record;
  }
  return meta ? { meta, turns, usage, state } : null;
}

/** Newest session id for a project (by file mtime), or null when none exist. */
export async function latestChatLogId(options: {
  root: string;
  projectRoot: string;
}): Promise<string | null> {
  const dir = projectDir(options.root, options.projectRoot);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { id: string; mtime: number } | null = null;
  for (const name of names) {
    const mtime = (await stat(join(dir, name))).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: name.slice(0, -6), mtime };
  }
  return best?.id ?? null;
}
