import { expect, test } from "bun:test";
import { createQuestionPort } from "./questions";

test("question port collects described choices and emits structured answers", async () => {
  const prompts: unknown[] = [];
  const events: unknown[] = [];
  const port = createQuestionPort({
    guided: {
      askInput: async (options) => {
        prompts.push(options);
        return "CLI";
      },
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
        multiSelect: false,
      },
    ]),
  ).resolves.toEqual([{ header: "Scope", question: "What should change?", answers: ["CLI"] }]);
  expect(prompts).toEqual([
    {
      label: "Scope\nWhat should change?",
      choices: [
        { label: "CLI", value: "CLI", description: "Change the command-line interface." },
        { label: "TUI", value: "TUI", description: "Change the terminal interface." },
        {
          label: "Type your own answer",
          value: "__agentj_question_custom__",
          description: "Enter a response not listed above.",
        },
      ],
    },
  ]);
  expect(events).toEqual([
    {
      type: "questions-answered",
      answers: [{ header: "Scope", question: "What should change?", answers: ["CLI"] }],
    },
  ]);
});

test("question port accepts a directly typed answer", async () => {
  const port = createQuestionPort({
    guided: { askInput: async () => "A bespoke scope" },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
        multiSelect: false,
      },
    ]),
  ).resolves.toEqual([
    { header: "Scope", question: "What should change?", answers: ["A bespoke scope"] },
  ]);
});

test("question port repeats multi-select input until Done", async () => {
  const answers = ["CLI", "TUI", "__agentj_question_done__"];
  const port = createQuestionPort({
    guided: { askInput: async () => answers.shift() ?? null },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
          { label: "Docs", description: "Change the project documentation." },
        ],
        multiSelect: true,
      },
    ]),
  ).resolves.toEqual([
    { header: "Scope", question: "What should change?", answers: ["CLI", "TUI"] },
  ]);
});

test("question port accepts and trims an explicit custom answer", async () => {
  const prompts: Array<{ label: string; validate?: (text: string) => string | null | undefined }> =
    [];
  const answers = ["__agentj_question_custom__", "  API  "];
  const port = createQuestionPort({
    guided: {
      askInput: async (options) => {
        prompts.push(options);
        return answers.shift() ?? null;
      },
    },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
        multiSelect: false,
      },
    ]),
  ).resolves.toEqual([{ header: "Scope", question: "What should change?", answers: ["API"] }]);
  expect(prompts[1]?.label).toBe("Scope\nWhat should change?\nType your own answer.");
  expect(prompts[1]?.validate?.("   ")).toBe("Enter an answer.");
});

test("question port returns to multi-select choices after cancelling custom input", async () => {
  const answers = [
    "__agentj_question_custom__",
    null,
    "CLI",
    "__agentj_question_custom__",
    "Other",
    "__agentj_question_done__",
  ];
  const port = createQuestionPort({
    guided: { askInput: async () => answers.shift() ?? null },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
        multiSelect: true,
      },
    ]),
  ).resolves.toEqual([
    { header: "Scope", question: "What should change?", answers: ["CLI", "Other"] },
  ]);
});

test("question port cancels the full batch without emitting answers", async () => {
  const events: unknown[] = [];
  const port = createQuestionPort({
    guided: { askInput: async () => null },
    onEvent: (event) => {
      events.push(event);
    },
  });

  await expect(
    port.ask([
      {
        header: "Scope",
        question: "What should change?",
        options: [
          { label: "CLI", description: "Change the command-line interface." },
          { label: "TUI", description: "Change the terminal interface." },
        ],
        multiSelect: false,
      },
    ]),
  ).resolves.toBeNull();
  expect(events).toEqual([]);
});
