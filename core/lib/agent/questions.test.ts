import { expect, test } from "bun:test";
import { createQuestionTool, questionBatchSchema } from "./questions";

test("ask_user returns structured answers", async () => {
  const batches: unknown[] = [];
  const tool = createQuestionTool({
    ask: async (questions) => {
      batches.push(questions);
      return [
        {
          header: "Scope",
          question: "What should change?",
          answers: ["CLI"],
        },
      ];
    },
  });
  const questions = [
    {
      header: "Scope",
      question: "What should change?",
      options: [
        { label: "CLI", description: "Change the command-line interface." },
        { label: "TUI", description: "Change the terminal interface." },
      ],
      multiSelect: false,
    },
  ];

  await expect(tool.execute({ questions })).resolves.toEqual({
    cancelled: false,
    answers: [{ header: "Scope", question: "What should change?", answers: ["CLI"] }],
  });
  expect(batches).toEqual([questions]);
});

test("ask_user reports cancellation without partial answers", async () => {
  const tool = createQuestionTool({ ask: async () => null });
  await expect(
    tool.execute({
      questions: [
        {
          header: "Scope",
          question: "What should change?",
          options: [
            { label: "CLI", description: "Change the command-line interface." },
            { label: "TUI", description: "Change the terminal interface." },
          ],
          multiSelect: false,
        },
      ],
    }),
  ).resolves.toEqual({ cancelled: true, answers: [] });
});

test("question batches require focused described choices", () => {
  expect(
    questionBatchSchema.safeParse([
      {
        header: "Scope",
        question: "What should change?",
        options: [{ label: "CLI", description: "Change the command-line interface." }],
      },
    ]).success,
  ).toBe(false);
  expect(
    questionBatchSchema.safeParse(
      Array.from({ length: 5 }, () => ({
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
      })),
    ).success,
  ).toBe(false);
});
