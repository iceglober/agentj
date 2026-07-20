export interface GuidedInputChoice {
  label: string;
  value: string;
  description?: string;
}

export type GuidedInputChoiceValue = string | GuidedInputChoice;

export interface GuidedInputOptions {
  label: string;
  masked?: boolean;
  initial?: string;
  choices?: readonly GuidedInputChoiceValue[];
  /** Return an error message to keep the prompt open. */
  validate?(text: string): string | null | undefined;
}

/** Interactive input capability used by commands that guide the user through setup. */
export interface GuidedInputPort {
  /** Returns null when the user cancels. */
  askInput(options: GuidedInputOptions): Promise<string | null>;
}

export const guidedChoice = (choice: GuidedInputChoiceValue): GuidedInputChoice =>
  typeof choice === "string" ? { label: choice, value: choice } : choice;
