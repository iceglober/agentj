import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { UndoStack } from "../session/undo";
import type { ChatEvent } from "./events";
import type { JobRunner } from "./jobs";
import type { ChatSession } from "./session";

/**
 * Input routing for the chat screen: slash commands (handled locally, never
 * sent to the model), `&`-prefixed background jobs, and ordinary messages.
 * Commands live in a keyed registry (the checkGraders/editModes idiom) so
 * custom commands have an obvious extension point later.
 */

export type ParsedInput =
  | { kind: "command"; name: string; args: string }
  | { kind: "job"; prompt: string }
  | { kind: "message"; text: string };

export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (text.startsWith("/")) {
    const [name = "", ...rest] = text.slice(1).split(/\s+/);
    return { kind: "command", name: name.toLowerCase(), args: rest.join(" ") };
  }
  if (text.startsWith("&")) return { kind: "job", prompt: text.slice(1).trim() };
  return { kind: "message", text };
}

const AT_FILE_LIMIT = 16_384;
const AT_FILE_PATTERN = /(^|\s)@([\w./~-]+)/g;

/** Expand `@path` references into bounded attachment blocks (missing → left as-is). */
export async function expandAtFiles(text: string, cwd: string): Promise<string> {
  const attachments: string[] = [];
  for (const match of text.matchAll(AT_FILE_PATTERN)) {
    const reference = match[2];
    if (!reference) continue;
    const path = isAbsolute(reference) ? reference : join(cwd, reference);
    try {
      if (!(await stat(path)).isFile()) continue;
      const content = await readFile(path, "utf8");
      const clipped = content.length > AT_FILE_LIMIT;
      attachments.push(
        `--- @${reference}${clipped ? " (truncated)" : ""} ---\n${content.slice(0, AT_FILE_LIMIT)}`,
      );
    } catch {
      // Not a readable file — leave the mention untouched.
    }
  }
  return attachments.length > 0 ? `${text}\n\n${attachments.join("\n\n")}` : text;
}

export interface ChatCommandContext {
  session: ChatSession;
  jobs: JobRunner;
  undo?: UndoStack;
  emit(event: ChatEvent): void;
  /** Ends the interactive session. */
  quit(): void;
  /** Clears the visible transcript (screen-level concern). */
  clear?(): void;
}

type ChatCommand = {
  summary: string;
  run(context: ChatCommandContext, args: string): Promise<void> | void;
};

/** Registry keyed by command name — same idiom as checkGraders/editModes. */
export const chatCommands: Record<string, ChatCommand> = {
  help: {
    summary: "List commands and keys",
    run(context) {
      const lines = Object.entries(chatCommands).map(
        ([name, command]) => `/${name} — ${command.summary}`,
      );
      lines.push(
        "& <task> — run as a background job",
        "@path/to/file — attach file contents",
        "Tab — toggle plan/build · Esc — interrupt turn · Ctrl+C×2 — quit",
      );
      context.emit({ type: "notice", text: lines.join("\n") });
    },
  },
  jobs: {
    summary: "List background jobs, or `/jobs abort <id>`",
    run(context, args) {
      const [action, id] = args.split(/\s+/);
      if (action === "abort" && id) {
        const aborted = context.jobs.abort(id);
        context.emit({
          type: "notice",
          text: aborted ? `Aborting ${id}.` : `No running job ${id}.`,
        });
        return;
      }
      const jobs = context.jobs.list();
      context.emit({
        type: "notice",
        text:
          jobs.length === 0
            ? "No jobs this session."
            : jobs
                .map((job) => `${job.id} [${job.status}] (${job.mode}) ${job.prompt.slice(0, 60)}`)
                .join("\n"),
      });
    },
  },
  undo: {
    summary: "Revert the agent's last file changes",
    async run(context) {
      const label = await context.undo?.undo();
      context.emit({
        type: "notice",
        text: label ? `Restored to: ${label}` : "Nothing to undo.",
      });
    },
  },
  redo: {
    summary: "Re-apply reverted changes",
    async run(context) {
      const label = await context.undo?.redo();
      context.emit({
        type: "notice",
        text: label ? `Re-applied: ${label}` : "Nothing to redo.",
      });
    },
  },
  clear: {
    summary: "Clear the transcript view",
    run(context) {
      context.clear?.();
    },
  },
  quit: {
    summary: "End the session",
    run(context) {
      context.quit();
    },
  },
};

export async function runChatCommand(
  context: ChatCommandContext,
  name: string,
  args: string,
): Promise<void> {
  const command = chatCommands[name];
  if (!command) {
    context.emit({ type: "notice", text: `Unknown command /${name} — try /help.` });
    return;
  }
  await command.run(context, args);
}
