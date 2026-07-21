import { expect, test } from "bun:test";
import { compactModelMessages } from "./continuation";

test("compactModelMessages replaces old tool-heavy turns and preserves recent turns", () => {
  const messages = Array.from({ length: 8 }, (_, index) => [
    { role: "user", content: `request ${index}` },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
    { role: "tool", content: [{ type: "tool-result", output: "x".repeat(1_000) }] },
  ]).flat();
  const compacted = compactModelMessages(messages, { recentUserTurns: 2 });

  expect(compacted).toHaveLength(7);
  expect(compacted[0]).toMatchObject({ role: "user" });
  expect(JSON.stringify(compacted[0])).toContain("request 0");
  expect(JSON.stringify(compacted[0])).not.toContain("x".repeat(100));
  expect(compacted.slice(1)).toEqual(messages.slice(18));
});

test("compactModelMessages keeps short continuations byte-for-byte", () => {
  const messages = [{ role: "user", content: "one" }];
  expect(compactModelMessages(messages)).toBe(messages);
});
