import type { Readable, Writable } from "node:stream";

export interface PromptUi {
  askTask(options?: PromptIo): Promise<string | null>;
  askFollowUp?(options?: PromptIo): Promise<string | null>;
}

export interface PromptIo {
  stdin?: Readable;
  stdout?: Writable;
}

export interface TextPromptRequest extends PromptIo {
  message: string;
  hint: string;
  validationMessage?: string;
}

export interface TextPromptEditor {
  read(request: TextPromptRequest): Promise<string | null>;
}

export type InteractiveInputGate = boolean | ((stdin?: Readable) => boolean);

export interface CreatePromptUiOptions extends PromptIo {
  editor: TextPromptEditor;
  isInteractive?: InteractiveInputGate;
}

const normalizeRequiredText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPromptInputClosed = (stdin?: Readable): boolean =>
  stdin?.destroyed === true || stdin?.readableEnded === true;

const resolveInteractiveInput = (
  gate: InteractiveInputGate | undefined,
  stdin?: Readable,
): boolean => {
  if (isPromptInputClosed(stdin)) return false;
  if (typeof gate === "function") return gate(stdin);
  return gate ?? true;
};

interface RequiredTextPrompt {
  message: string;
  hint: string;
  validationMessage: string;
}

export const createPromptUi = (options: CreatePromptUiOptions): PromptUi => {
  const readRequiredText = async (
    prompt: RequiredTextPrompt,
    override: PromptIo,
  ): Promise<string | null> => {
    const stdin = override.stdin ?? options.stdin;
    const stdout = override.stdout ?? options.stdout;

    // The validation banner is shown only on retries after a blank submission.
    let validationMessage: string | undefined;
    while (resolveInteractiveInput(options.isInteractive, stdin)) {
      const value = await options.editor.read({
        message: prompt.message,
        hint: prompt.hint,
        ...(stdin ? { stdin } : {}),
        ...(stdout ? { stdout } : {}),
        ...(validationMessage ? { validationMessage } : {}),
      });
      if (value === null) return null;
      const normalized = normalizeRequiredText(value);
      if (normalized !== null) return normalized;
      validationMessage = prompt.validationMessage;
    }
    return null;
  };

  return {
    askTask: (override = {}) =>
      readRequiredText(
        {
          message:
            "What should AgentJ plan and build?\nExamples: fix a failing test; explain a module boundary; add a targeted regression test.",
          hint: "Describe one coding task.",
          validationMessage: "Enter a task, or press Ctrl+C to cancel.",
        },
        override,
      ),
    askFollowUp: (override = {}) =>
      readRequiredText(
        {
          message: "Review the plan: provide feedback, or type 'proceed' to build.",
          hint: "Feedback or explicit approval.",
          validationMessage: "Enter feedback, approval, or press Ctrl+C to stop.",
        },
        override,
      ),
  };
};
