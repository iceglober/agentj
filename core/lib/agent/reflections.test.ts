import { describe, expect, test } from "bun:test";
import { agentConfigSchema } from ".";
import { createPlanReflectionFollowUp } from "./reflections";

describe("plan reflections", () => {
  test("is disabled by an empty prompt map", async () => {
    const config = agentConfigSchema.parse({});
    expect(
      await createPlanReflectionFollowUp({
        config,
        request: "request",
        draft: "draft",
        abortSignal: new AbortController().signal,
        createWorker: async () => {
          throw new Error("should not run");
        },
      }),
    ).toBeNull();
  });

  test("runs named reviews in parallel and builds a labeled revision follow-up", async () => {
    const config = agentConfigSchema.parse({
      reflections: {
        prompts: { architecture: "Find simpler boundaries.", testing: "Find test gaps." },
      },
      tools: { maxOutputChars: 1_000, subagents: { concurrency: 2 } },
    });
    const prompts: Record<string, string> = {};
    const followUp = await createPlanReflectionFollowUp({
      config,
      request: "Add reflections",
      draft: "Draft plan",
      abortSignal: new AbortController().signal,
      createWorker: async (task) => ({
        generate: async (prompt) => {
          prompts[task.id] = prompt;
          return {
            text: `${task.id} finding`,
            steps: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        },
      }),
    });

    expect(prompts.architecture).toContain("Draft plan");
    expect(prompts.testing).toContain("Add reflections");
    expect(followUp).toMatchObject({ transcriptText: "Reflections: architecture ✓ · testing ✓" });
    expect("text" in (followUp ?? {})).toBe(true);
  });

  test("keeps the draft when every worker fails", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "Review it." } },
    });
    await expect(
      createPlanReflectionFollowUp({
        config,
        request: "request",
        draft: "draft",
        abortSignal: new AbortController().signal,
        createWorker: async () => ({
          generate: async () => {
            throw new Error("unavailable");
          },
        }),
      }),
    ).resolves.toEqual({ notice: "Reflections failed; keeping draft." });
  });

  test("propagates an aborted reflection run instead of reporting a failure", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "Review it." } },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createPlanReflectionFollowUp({
        config,
        request: "request",
        draft: "draft",
        abortSignal: controller.signal,
        createWorker: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toThrow("Aborted");
  });
});
