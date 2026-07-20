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
