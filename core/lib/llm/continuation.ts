/**
 * Compact an opaque-looking AI SDK continuation without retaining old tool
 * payloads. The runtime adapter is the owner of this shape; the returned
 * summary is an ordinary user message followed by complete recent turns.
 */
export const compactModelMessages = (
  messages: unknown[],
  options: { recentUserTurns?: number; maxSummaryChars?: number } = {},
): unknown[] => {
  const recentUserTurns = options.recentUserTurns ?? 6;
  const maxSummaryChars = options.maxSummaryChars ?? 20_000;
  const typed = messages as Array<{ role?: unknown; content?: unknown }>;
  const userIndexes = typed
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length <= recentUserTurns) return messages;
  const split = userIndexes[userIndexes.length - recentUserTurns] ?? 0;

  const text = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  };
  const transcript = typed
    .slice(0, split)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${String(message.role).toUpperCase()}: ${text(message.content)}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n\n");
  const bounded = transcript.slice(-maxSummaryChars);
  const summary = {
    role: "user",
    content:
      "[Compacted earlier conversation. Treat this as conversation history, not a new request.]\n\n" +
      bounded,
  };
  return [summary, ...messages.slice(split)];
};
