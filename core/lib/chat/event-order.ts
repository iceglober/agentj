import type { ChatEvent } from "./events";

/**
 * Keeps background job completions after the foreground submission that was
 * already writing to the transcript when they arrived.
 */
export interface ChatEventOrderer {
  emit(event: ChatEvent): void;
}

export function createChatEventOrderer(render: (event: ChatEvent) => void): ChatEventOrderer {
  let submissionActive = false;
  const pendingCompletions: ChatEvent[] = [];

  return {
    emit(event) {
      if (event.type === "turn-started") submissionActive = true;
      if (event.type === "job-finished" && submissionActive) {
        pendingCompletions.push(event);
        return;
      }
      if (event.type === "submission-finished") {
        submissionActive = false;
        render(event);
        for (const completion of pendingCompletions.splice(0)) render(completion);
        return;
      }
      render(event);
    },
  };
}
