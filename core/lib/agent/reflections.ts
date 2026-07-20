import z from "zod";
import { truncateWithNotice } from "../truncation";
import type { AgentConfig } from ".";
import type { SubagentProgressEvent, SubagentRunner, SubagentsResult } from "./subagents";
import { runSubagentTasks } from "./subagents";

/** Optional parallel reviews that revise a completed plan exactly once. */
export const reflectionsConfigSchema = z
  .object({
    /** Named review instructions. An empty map disables plan reflections. */
    prompts: z
      .record(
        z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Za-z0-9_-]+$/u),
        z.string().trim().min(1),
      )
      .default({}),
    /** Explicit provider override for reflection workers. */
    provider: z.enum(["azure"]).optional(),
    /** Explicit model override. It wins over tier. */
    model: z.string().trim().min(1).optional(),
    /** Ladder tier for reflection workers. */
    tier: z.number().int().min(0).optional(),
  })
  .prefault({});

export type ReflectionFollowUp = { text: string; transcriptText: string };

export interface CreatePlanReflectionsOptions {
  config: AgentConfig;
  /** The draft plan model, used only for the live child-model label. */
  parentModel?: { provider: string; model: string };
  request: string;
  draft: string;
  abortSignal: AbortSignal;
  createWorker(task: { id: string }): Promise<SubagentRunner>;
  onProgress?(event: SubagentProgressEvent): void | Promise<void>;
}

const summary = (results: SubagentsResult["results"]): string =>
  `Reflections: ${results
    .map((result) => `${result.id} ${result.outcome === "completed" ? "✓" : result.outcome}`)
    .join(" · ")}`;

/**
 * Run independent read-only reviews and turn successful findings into one
 * internal follow-up for the primary plan agent. Worker failures are reported
 * in the transcript summary but never discard the already-persisted draft.
 */
export async function createPlanReflectionFollowUp(
  options: CreatePlanReflectionsOptions,
): Promise<ReflectionFollowUp | { notice: string } | null> {
  const entries = Object.entries(options.config.reflections.prompts);
  if (entries.length === 0) return null;

  const result = await runSubagentTasks(
    {
      execution: {
        kind: "research",
        createWorker: async (task) => options.createWorker({ id: task.id }),
      },
      concurrency: options.config.tools.subagents.concurrency,
      ...(options.parentModel &&
      (options.parentModel.provider !== options.config.llm.provider ||
        options.parentModel.model !== options.config.llm.model)
        ? { model: `${options.config.llm.provider}/${options.config.llm.model}` }
        : {}),
      onProgress: options.onProgress,
    },
    {
      tasks: entries.map(([id, prompt]) => ({
        id,
        title: `Review ${id}`,
        prompt: [
          prompt,
          "Review the following user request and draft plan. Return concise, concrete findings for the primary agent; do not write code.",
          `User request:\n${options.request}`,
          `Draft plan:\n${options.draft}`,
        ].join("\n\n"),
        waitsOn: [],
      })),
    },
    { abortSignal: options.abortSignal },
  );
  if (options.abortSignal.aborted) throw new DOMException("Aborted", "AbortError");

  const successful = result.results.filter(
    (entry): entry is (typeof result.results)[number] & { text: string } =>
      entry.outcome === "completed" && entry.text !== null,
  );
  if (successful.length === 0) return { notice: "Reflections failed; keeping draft." };

  const cap = options.config.tools.maxOutputChars;
  const findings = successful
    .map(({ id, text }) => `${id}:\n${truncateWithNotice(text, cap)}`)
    .join("\n\n");
  return {
    transcriptText: summary(result.results),
    text: [
      "Revise your preceding plan using the independent reflections below. Return a complete revised plan, not a diff. Keep valid parts, correct weak parts, and do not claim work is implemented.",
      `Original user request:\n${options.request}`,
      `Draft plan:\n${options.draft}`,
      `Reflections:\n${findings}`,
    ].join("\n\n"),
  };
}
