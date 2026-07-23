import { join } from "node:path";
import type { Sandbox } from "../sandbox";
import { createChatLog, latestChatLogId, loadChatLog } from "../session/log";
import { createPromptHistory } from "../session/prompt-history";
import { createUndoStack } from "../session/undo";

interface SessionBootstrapDependencies {
  createPromptHistory: typeof createPromptHistory;
  latestChatLogId: typeof latestChatLogId;
  loadChatLog: typeof loadChatLog;
  createChatLog: typeof createChatLog;
  createUndoStack: typeof createUndoStack;
}

const defaults: SessionBootstrapDependencies = {
  createPromptHistory,
  latestChatLogId,
  loadChatLog,
  createChatLog,
  createUndoStack,
};

/** Resolves resume intent and constructs the durable state for an interactive chat. */
export const bootstrapInteractiveSession = async (
  options: {
    stateRoot: string;
    projectRoot: string;
    projectIdentity: string;
    environment: Sandbox;
    resume?: string;
    continueLatest?: boolean;
  },
  dependencies: SessionBootstrapDependencies = defaults,
) => {
  const chatsRoot = join(options.stateRoot, "glorious", "chats");
  const promptHistory = await dependencies.createPromptHistory({
    root: join(options.stateRoot, "glorious", "prompt-history"),
    projectIdentity: options.projectIdentity,
  });
  let resumeId = options.resume ?? null;
  if (!resumeId && options.continueLatest) {
    resumeId = await dependencies.latestChatLogId({
      root: chatsRoot,
      projectRoot: options.projectRoot,
    });
    if (!resumeId)
      return { ok: false as const, error: "No previous chat session for this project." };
  }
  const resumed = resumeId
    ? await dependencies.loadChatLog({
        root: chatsRoot,
        projectRoot: options.projectRoot,
        id: resumeId,
      })
    : null;
  if (resumeId && !resumed) {
    return { ok: false as const, error: `Unknown chat session: ${resumeId}` };
  }
  const log = await dependencies.createChatLog({
    root: chatsRoot,
    projectRoot: options.projectRoot,
    ...(resumeId ? { id: resumeId } : {}),
  });
  return {
    ok: true as const,
    promptHistory,
    resumed,
    log,
    undo: dependencies.createUndoStack(options.environment, options.projectRoot, log.id),
  };
};
