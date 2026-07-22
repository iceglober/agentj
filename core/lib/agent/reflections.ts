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
    /** Sampling temperature for reflection workers; higher = more divergent
     *  challenging. Omitted → the model default. */
    temperature: z.number().min(0).max(2).optional(),
  })
  .prefault({});

const SUMMARY_CAP = 64;
const shorten = (value: string): string => {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > SUMMARY_CAP ? `${line.slice(0, SUMMARY_CAP - 1)}…` : line;
};

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
        title: `Reflect ${id}`,
        prompt: [
          prompt,
          options.phase === "pre_turn"
            ? `You are the primary agent's own reflective voice — its first-person second thoughts before it plans. Investigate the task against the real code with your tools: what it truly involves, what already exists, and what is risky or unclear. Report what you found, not what you would check. Write as "I", in a few concrete sentences. Do not write a plan and do not write code.`
            : `You are the primary agent's own reflective voice — its first-person second thoughts on the plan it just drafted. Verify the plan against the real code with your tools: confirm that what each claim depends on actually exists and works, and surface what is thin, wrong, or missing. Do not speculate — check what you can and report what you found; say you are unsure only about what you truly could not resolve. Write as "I", in a few concrete sentences. Do not rewrite the plan and do not write code.`,
          `Task:\n${options.request}`,
          ...(options.phase === "pre_turn" ? [] : [`Plan I drafted:\n${options.draft}`]),
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
  const model = options.reflectionModel ? ` · ${options.reflectionModel.split("/").pop()}` : "";
  const reflections = result.results.map((entry) => {
    if (entry.outcome === "completed" && entry.text !== null) {
      const line = entry.text.replace(/\s+/gu, " ").trim();
      return `  ${line.length > 400 ? `${line.slice(0, 399).trimEnd()}…` : line}`;
    }
    return `  ✗ ${entry.id} — ${shorten(entry.error ?? entry.outcome)}`;
  });
  const transcriptText = [`Reflection${model}`, reflections.join("\n\n")].join("\n");
  if (options.phase === "pre_turn") {
    return {
      transcriptText,
      context: [
        "Before planning, here are your own first-person reflections on the task. Treat them as your own second thoughts and let them shape the plan. Do not mention the reflection process.",
        `Reflections:\n${findings}`,
      ].join("\n\n"),
    };
  }
  return {
    transcriptText,
    text: [
      "Below are your own reflections on the plan you just wrote — your second thoughts, in your own voice. They inspected the code, so revise directly from what they verified: do not re-open files or re-run searches. Fold in the depth and corrections they add. But do not weaken or drop a claim just because a reflection was unsure or said it had not checked — only change what a reflection actually verified as wrong. Respond in the first person — tighten specific steps and say what still stands. Do not restate the whole plan and do not write code.",
      `Reflections:\n${findings}`,
    ].join("\n\n"),
  };
}
