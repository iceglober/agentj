import { describe, expect, test } from "bun:test";
import { agentConfigSchema } from ".";
import {
  createPlanReflectionFollowUp,
  extractReflectionSelection,
  reflectionsConfigSchema,
} from "./reflections";

describe("plan reflections", () => {
  test("temperature defaults to undefined and accepts an override in range", () => {
    expect(reflectionsConfigSchema.parse({}).temperature).toBeUndefined();
    expect(reflectionsConfigSchema.parse({ temperature: 1.2 }).temperature).toBe(1.2);
    expect(() => reflectionsConfigSchema.parse({ temperature: 2.5 })).toThrow();
  });

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

  test("runs first-person reflections in parallel and builds a continuation follow-up", async () => {
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
      phase: "post_turn",
      abortSignal: new AbortController().signal,
      createWorker: async (task) => ({
        generate: async (prompt) => {
          prompts[task.id] = prompt;
          return {
            text: `I am assuming ${task.id} holds`,
            steps: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        },
      }),
    });

    // First-person, plan-labeled worker prompt.
    expect(prompts.architecture).toContain('Write as "I"');
    expect(prompts.architecture).toContain("Plan I drafted:\nDraft plan");
    expect(prompts.architecture).toContain("rewrite the plan"); // post_turn wording
    expect(prompts.testing).toContain("Task:\nAdd reflections");
    // Reflection prose is shown dim, one indented paragraph per worker.
    const { transcriptText, text } = followUp as { transcriptText: string; text: string };
    expect(transcriptText).toBe(
      "Reflection\n  I am assuming architecture holds\n\n  I am assuming testing holds",
    );
    // The follow-up is a first-person continuation, not a re-plan.
    expect(text).toContain("your own reflection on the plan you just wrote");
    expect(text).toContain("I am assuming architecture");
    // Not a re-plan: no revised-plan heading and no "rewrite the plan" instruction.
    expect(text).not.toContain("# Revised");
    expect(text).not.toContain("Original user request");
  });

  test("collapses reflection whitespace and hard-caps the displayed prose", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "Reflect on it." } },
      tools: { maxOutputChars: 4_000 },
    });
    const prose = `I am worried about\n\n  the plan   because ${"detail ".repeat(60)}end`;
    const followUp = await createPlanReflectionFollowUp({
      config,
      request: "request",
      draft: "draft",
      phase: "post_turn",
      abortSignal: new AbortController().signal,
      createWorker: async () => ({
        generate: async () => ({
          text: prose,
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }),
      }),
    });
    const transcriptText = (followUp as { transcriptText: string }).transcriptText;
    const line = transcriptText.split("\n").at(-1) ?? "";
    // Collapsed to a single indented line, newlines gone.
    expect(line.startsWith("  I am worried about the plan because ")).toBe(true);
    expect(line).not.toContain("\n");
    // Hard-capped at the 400-char display budget with a clean ellipsis, not the
    // ugly mid-sentence `[trunc N chars]` notice.
    expect(line.length).toBeLessThanOrEqual(400 + 3);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("[trunc");
    // The model still receives the full prose through the findings text.
    expect((followUp as { text: string }).text).toContain("end");
  });

  test("runs only the selected reflections and preserves configured order", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "A", testing: "T", security: "S" } },
    });
    const ran: string[] = [];
    const followUp = await createPlanReflectionFollowUp({
      config,
      selectedIds: ["security", "security"],
      request: "request",
      draft: "draft",
      phase: "post_turn",
      abortSignal: new AbortController().signal,
      createWorker: async (task) => ({
        generate: async () => {
          ran.push(task.id);
          return {
            text: `${task.id} finding`,
            steps: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        },
      }),
    });
    expect(ran).toEqual(["security"]);
    expect(followUp).toMatchObject({ transcriptText: expect.stringContaining("security finding") });
    expect(followUp).not.toMatchObject({ transcriptText: expect.stringContaining("architecture") });
  });

  test("extracts the last valid reflection selection and distinguishes omission", () => {
    expect(extractReflectionSelection({ steps: [] }, ["a", "b"])).toBeNull();
    expect(
      extractReflectionSelection(
        {
          steps: [
            { toolCalls: [{ name: "select_reflections", input: { ids: ["a"] } }], toolResults: [] },
            {
              toolCalls: [{ name: "select_reflections", input: { ids: ["b", "b"] } }],
              toolResults: [],
            },
          ],
        },
        ["a", "b"],
      ),
    ).toEqual(["b"]);
    expect(
      extractReflectionSelection(
        {
          steps: [
            {
              toolCalls: [{ name: "select_reflections", input: { ids: ["unknown"] } }],
              toolResults: [],
            },
          ],
        },
        ["a"],
      ),
    ).toBeNull();
    expect(
      extractReflectionSelection(
        {
          steps: [
            { toolCalls: [{ name: "select_reflections", input: { ids: [] } }], toolResults: [] },
          ],
        },
        ["a"],
      ),
    ).toEqual([]);
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
