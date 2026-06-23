import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV1, simulateReadableStream } from "ai/test";
import { Ledger } from "../src/ledger/index.ts";
import { runOnce } from "../src/runner.ts";

// N5: the loop is testable against a mock model — no network, no API key.
describe("runOnce against a mock model", () => {
  test("executes a tool call, then finishes, and writes a receipt", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          // Step 1: say something, then call write_file.
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            stream: simulateReadableStream({
              chunks: [
                { type: "text-delta", textDelta: "Creating the file." },
                {
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "c1",
                  toolName: "write_file",
                  args: JSON.stringify({ path: "out.txt", content: "generated" }),
                },
                { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 10, completionTokens: 5 } },
              ],
            }),
          };
        }
        // Step 2: wrap up.
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          stream: simulateReadableStream({
            chunks: [
              { type: "text-delta", textDelta: "Done." },
              { type: "finish", finishReason: "stop", usage: { promptTokens: 20, completionTokens: 8 } },
            ],
          }),
        };
      },
    });

    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({ task: "create out.txt with 'generated'", root, tier: "mid", model });

      expect(res.ok).toBe(true);
      expect(res.finishReason).toBe("stop");

      // The tool actually ran end-to-end.
      expect(await readFile(join(root, "out.txt"), "utf8")).toBe("generated");

      // Exactly one receipt, with usage + a computed cost.
      const receipts = await new Ledger(join(root, ".coder", "ledger.jsonl")).all();
      expect(receipts).toHaveLength(1);
      expect(receipts[0].outputTokens).toBeGreaterThan(0);
      expect(receipts[0].inputTokens).toBeGreaterThan(0);
      expect(receipts[0].costUsd).toBeGreaterThan(0);
      expect(receipts[0].accuracy.kind).toBe("unverified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
