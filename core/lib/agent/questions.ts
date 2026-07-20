import { z } from "zod";
import { defineTool } from "../llm";

const optionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(280),
});

export const questionSchema = z.object({
  header: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(500),
  options: z.array(optionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
});

export const questionBatchSchema = z.array(questionSchema).min(1).max(4);
export type Question = z.infer<typeof questionSchema>;
export type QuestionBatch = z.infer<typeof questionBatchSchema>;

export interface QuestionAnswer {
  header: string;
  question: string;
  answers: string[];
}

/** A narrow interactive-session capability; agents never depend on chat or TUI code. */
export interface QuestionPort {
  ask(questions: QuestionBatch): Promise<QuestionAnswer[] | null>;
}

const inputSchema = z.object({ questions: questionBatchSchema });

/** Ask the interactive user a small batch of structured questions. */
export const createQuestionTool = (port: QuestionPort) =>
  defineTool({
    description: [
      "Ask the interactive user for information needed to continue work.",
      "Use this only when the answer would materially change the work; ask before dependent work.",
      "Send one to four focused questions. Each question needs two to four described options; users can",
      "also enter free text. Set multiSelect when more than one answer may apply. Do not use this tool",
      "in place of a clear recommendation: state the recommended option first when useful.",
    ].join("\n"),
    inputSchema,
    execute: async ({ questions }) => {
      const answers = await port.ask(questions);
      return answers === null ? { cancelled: true, answers: [] } : { cancelled: false, answers };
    },
  });
