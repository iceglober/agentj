import { createRequire } from "node:module";
import { fuzzyFilter } from "./fuzzy";
import { type GuidedInputPort, guidedChoice } from "./guided-input";

/** `prompts` implementation of the guided-input port for short standalone CLI flows. */
export const createPromptsGuidedInput = (): GuidedInputPort => ({
  async askInput(options) {
    const prompts = createRequire(import.meta.url)("prompts") as (
      question: Record<string, unknown>,
      options: { onCancel: () => void },
    ) => Promise<{ value?: unknown }>;
    const choices = (options.choices ?? []).map(guidedChoice);
    let cancelled = false;
    const answer = await prompts(
      {
        type: choices.length > 0 ? "autocomplete" : options.masked ? "password" : "text",
        name: "value",
        message: options.label,
        ...(options.initial === undefined ? {} : { initial: options.initial }),
        ...(choices.length === 0
          ? {}
          : {
              choices: choices.map((choice) => ({
                title: choice.label,
                value: choice.value,
                ...(choice.description === undefined ? {} : { description: choice.description }),
              })),
              suggest: (input: string) =>
                Promise.resolve(
                  fuzzyFilter(input, choices, (choice) => choice.label).map((choice) => ({
                    title: choice.label,
                    value: choice.value,
                    ...(choice.description === undefined
                      ? {}
                      : { description: choice.description }),
                  })),
                ),
            }),
        ...(options.validate === undefined ? {} : { validate: options.validate }),
      },
      { onCancel: () => (cancelled = true) },
    );
    return cancelled || typeof answer.value !== "string" ? null : answer.value;
  },
});
