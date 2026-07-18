export interface GuidedInputOptions {
  label: string;
  masked?: boolean;
  choices?: readonly string[];
  /** Return an error message to keep the prompt open. */
  validate?(text: string): string | null | undefined;
}

/** Interactive input capability used by commands that guide the user through setup. */
export interface GuidedInputPort {
  /** Returns null when the user cancels. */
  askInput(options: GuidedInputOptions): Promise<string | null>;
}
