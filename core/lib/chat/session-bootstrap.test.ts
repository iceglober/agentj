import { describe, expect, test } from "bun:test";
import type { Sandbox } from "../sandbox";
import type { ChatLog, LoadedChatLog } from "../session/log";
import type { PromptHistory } from "../session/prompt-history";
import type { UndoStack } from "../session/undo";
import { bootstrapInteractiveSession } from "./session-bootstrap";

const environment = {} as Sandbox;
const promptHistory = { entries: [], append: async () => {}, path: "/history" } as PromptHistory;
const log = { id: "s1", path: "/log", append: async () => {} } as ChatLog;
const undo = {} as UndoStack;
const dependencies = (latest: string | null, loaded: LoadedChatLog | null = null) => ({
  createPromptHistory: async () => promptHistory,
  latestChatLogId: async () => latest,
  loadChatLog: async () => loaded,
  createChatLog: async () => log,
  createUndoStack: () => undo,
});

describe("bootstrapInteractiveSession", () => {
  test("reports an empty continuation without constructing a log", async () => {
    const result = await bootstrapInteractiveSession(
      {
        stateRoot: "/state",
        projectRoot: "/repo",
        projectIdentity: "/git",
        environment,
        continueLatest: true,
      },
      dependencies(null),
    );
    expect(result).toEqual({ ok: false, error: "No previous chat session for this project." });
  });

  test("returns the shared persistence bundle for a new session", async () => {
    const result = await bootstrapInteractiveSession(
      { stateRoot: "/state", projectRoot: "/repo", projectIdentity: "/git", environment },
      dependencies(null),
    );
    expect(result).toMatchObject({ ok: true, promptHistory, resumed: null, log, undo });
  });

  test("rejects an explicitly unknown resume id", async () => {
    const result = await bootstrapInteractiveSession(
      {
        stateRoot: "/state",
        projectRoot: "/repo",
        projectIdentity: "/git",
        environment,
        resume: "missing",
      },
      dependencies(null),
    );
    expect(result).toEqual({ ok: false, error: "Unknown chat session: missing" });
  });
});
