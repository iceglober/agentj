import z from "zod";
import type { RunResult } from "../llm";
import { defineTool } from "../llm";
import { truncateWithNotice } from "../truncation";
import type { AgentConfig } from ".";
import type { SubagentProgressEvent, SubagentRunner } from "./subagents";
import { runSubagentTasks } from "./subagents";

export const reflectionEvents = [
  "plan.once.pre_turn",
  "plan.each.pre_turn",
  "plan.once.post_turn",
  "plan.each.post_turn",
] as const;

export type ReflectionEvent = (typeof reflectionEvents)[number];
export const reflectionEventSchema = z.enum(reflectionEvents);

export const reflectionSelectionInputSchema = z.object({
  ids: z.array(z.string().min(1).max(32)).max(32),
});
export type ReflectionSelection = string[] | null;

export const createReflectionSelectionTool = (prompts: Readonly<Record<string, string>>) =>
  defineTool({
    description: [
      "When your plan draft is complete, choose which independent reflections should review it.",
      "Call exactly once. Select zero or more IDs; an empty list skips reflections.",
      `Available reflections: ${Object.entries(prompts)
        .map(([id, prompt]) => `${id}: ${prompt}`)
        .join("; ")}`,
    ].join(" "),
    inputSchema: reflectionSelectionInputSchema,
    execute: () => "Reflection selection recorded.",
  });

export const extractReflectionSelection = (
  result: Pick<RunResult, "steps">,
  availableIds: readonly string[],
): ReflectionSelection => {
  const available = new Set(availableIds);
  let selection: ReflectionSelection = null;
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (call.name !== "select_reflections") continue;
      const parsed = reflectionSelectionInputSchema.safeParse(call.input);
      if (!parsed.success || parsed.data.ids.some((id) => !available.has(id))) continue;
      selection = [...new Set(parsed.data.ids)];
    }
  }
  return selection;
};

/** Optional parallel reviews scheduled around plan turns. */
export const reflectionsConfigSchema = z
  .object({
    /** Reflection hooks. Empty disables scheduling. */
    events: z.array(reflectionEventSchema).default(["plan.once.post_turn"]),
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
export type ReflectionPreparation =
  | ReflectionFollowUp
  | { context: string; transcriptText: string }
  | { notice: string };

export interface CreatePlanReflectionsOptions {
  config: AgentConfig;
  /** The draft plan model, used only for the live child-model label. */
  parentModel?: { provider: string; model: string };
  request: string;
  draft: string;
  phase?: "pre_turn" | "post_turn";
  abortSignal: AbortSignal;
  createWorker(task: { id: string }): Promise<SubagentRunner>;
  onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  /** Reflection worker model shown in the completed reflection transcript. */
  reflectionModel?: string;
  /** IDs selected by the completed plan draft; undefined means all. */
  selectedIds?: readonly string[];
}

/**
 * Run independent read-only reviews and turn successful findings into either
 * context for the current plan turn or one internal follow-up. Worker failures
 * never discard an already-persisted draft.
 */
export async function createPlanReflectionFollowUp(
  options: CreatePlanReflectionsOptions,
): Promise<ReflectionPreparation | null> {
  const allEntries = Object.entries(options.config.reflections.prompts);
  if (allEntries.length === 0) return null;
  const selected = options.selectedIds === undefined ? null : new Set(options.selectedIds);
  const entries = selected === null ? allEntries : allEntries.filter(([id]) => selected.has(id));
  if (entries.length === 0) {
    return { notice: "Reflections skipped by plan selection." };
  }

  const result = await runSubagentTasks(
    {
      execution: {
        kind: "research",
        createWorker: async (task) => options.createWorker({ id: task.id }),
      },
      concurrency: options.config.tools.subagents.concurrency,
      model: `${options.config.llm.provider}/${options.config.llm.model}`,
      onProgress: options.onProgress,
    },
    {
      tasks: entries.map(([id, prompt]) => ({
        id,
        title: `Review ${id}`,
        prompt: [
          prompt,
          `Review the following user request and ${options.phase === "pre_turn" ? "repo context" : "draft plan"}. Return concise, concrete findings for the primary agent; do not write code.`,
          `User request:\n${options.request}`,
          ...(options.phase === "pre_turn" ? [] : [`Draft plan:\n${options.draft}`]),
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
  const model = options.reflectionModel ? ` · ${options.reflectionModel}` : "";
  const transcriptText = [
    `Reflections${model}`,
    ...result.results.map((entry) => {
      const marker = entry.outcome === "completed" && entry.text !== null ? "✓" : "x";
      const detail =
        entry.outcome === "completed" && entry.text !== null
          ? truncateWithNotice(entry.text, cap)
          : `${entry.error ?? entry.outcome} (not sent to the primary model)`;
      return `${marker} ${entry.id}\n${detail}`;
    }),
  ].join("\n\n");
  if (options.phase === "pre_turn") {
    return {
      transcriptText,
      context: [
        "Use these independent reflections while preparing the plan. Do not mention the reflection process unless useful.",
        `Reflections:\n${findings}`,
      ].join("\n\n"),
    };
  }
  return {
    transcriptText,
    text: [
      "Revise your preceding plan using the independent reflections below. Return a complete revised plan, not a diff. Keep valid parts, correct weak parts, and do not claim work is implemented.",
      `Original user request:\n${options.request}`,
      `Draft plan:\n${options.draft}`,
      `Reflections:\n${findings}`,
    ].join("\n\n"),
  };
}
