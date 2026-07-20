import type { ChatEvent } from "./events";

/** Render chat events in the order they are emitted. */
export interface ChatEventOrderer {
  emit(event: ChatEvent): void;
}

export function createChatEventOrderer(render: (event: ChatEvent) => void): ChatEventOrderer {
  return {
    emit: render,
  };
}
