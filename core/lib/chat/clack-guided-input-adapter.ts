import { autocomplete, isCancel, password, select, text } from "@clack/prompts";
import { type GuidedInputPort, guidedChoice } from "./guided-input";

const SHORT_CHOICES_MAX = 8;

/** Clack implementation of guided input for terminal flows that need native Esc cancellation. */
export const createClackGuidedInput = (): GuidedInputPort => ({
  async askInput(options) {
    const choices = (options.choices ?? []).map(guidedChoice);
    const validate = options.validate
      ? (value: string | undefined) =>
          value === undefined ? undefined : (options.validate?.(value) ?? undefined)
      : undefined;
    let answer: string | symbol;

    if (choices.length > 0) {
      const promptOptions = {
        message: options.label,
        options: choices.map((choice) => ({
          label: choice.label,
          value: choice.value,
          ...(choice.description === undefined ? {} : { hint: choice.description }),
        })),
        ...(options.initial === undefined ? {} : { initialValue: options.initial }),
      };
      answer =
        choices.length <= SHORT_CHOICES_MAX
          ? await select(promptOptions)
          : await autocomplete({ ...promptOptions, placeholder: "Type to search..." });
    } else if (options.masked) {
      answer = await password({ message: options.label, ...(validate ? { validate } : {}) });
    } else {
      answer = await text({
        message: options.label,
        ...(options.initial === undefined ? {} : { initialValue: options.initial }),
        ...(validate ? { validate } : {}),
      });
    }

    return isCancel(answer) || typeof answer !== "string" ? null : answer;
  },
});
