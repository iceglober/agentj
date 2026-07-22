import { describe, expect, test } from "bun:test";
import { agentConfigSchema } from ".";
import { createPlanReflectionFollowUp, extractReflectionSelection } from "./reflections";

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
    expect(followUp).toMatchObject({
      transcriptText:
        "Reflections\n\n✓ architecture — architecture finding\n\n✓ testing — testing finding",
    });
    expect(followUp).toMatchObject({ text: expect.stringContaining("architecture finding") });
  });

  test("renders a completion-report review as a terse status line, not raw JSON", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "Review it." } },
      tools: { maxOutputChars: 1_000 },
    });
    const followUp = await createPlanReflectionFollowUp({
      config,
      request: "request",
      draft: "draft",
      abortSignal: new AbortController().signal,
      createWorker: async () => ({
        generate: async () => ({
          text: JSON.stringify({
            status: "blocked",
            summary: "Boundary is unclear.",
            changes: ["one", "two", "three"],
            validation: [],
            nextSteps: [],
            openQuestions: ["Which module owns it?"],
          }),
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }),
      }),
    });
    expect(followUp).toMatchObject({
      transcriptText: "Reflections\n\n✗ architecture — Boundary is unclear.",
    });
    // The raw arrays never reach the human-facing transcript.
    expect(followUp).not.toMatchObject({
      transcriptText: expect.stringContaining("three"),
    });
  });

  test("shows only the review name when the review returns unparseable JSON", async () => {
    const config = agentConfigSchema.parse({
      reflections: { prompts: { architecture: "Review it." } },
      tools: { maxOutputChars: 2_000 },
    });
    // Unquoted keys / an off-schema status: not a valid completion report.
    const jsonish = '{status:"needs_escalation",changes:[],evidence:["README.md describes agentj"]}';
    const followUp = await createPlanReflectionFollowUp({
      config,
      request: "request",
      draft: "draft",
      abortSignal: new AbortController().signal,
      createWorker: async () => ({
        generate: async () => ({
          text: jsonish,
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }),
      }),
    });
    // Name only — no brace, no JSON, ever reaches the transcript.
    expect(followUp).toMatchObject({ transcriptText: "Reflections\n\n✓ architecture" });
    expect(followUp).not.toMatchObject({ transcriptText: expect.stringContaining("{") });
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
