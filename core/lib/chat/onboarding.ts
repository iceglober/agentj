/**
 * First-run gate. Interactive startup used to hard-error and exit when no
 * provider key was resolvable; this walks the user through setting one instead.
 * The model already has a working default, so the API key is the only real
 * blocker — keep the flow to that one step. Pure logic; the composition root
 * injects the masked prompt, the keychain write, and stdout.
 */

export interface OnboardingPort {
  /** Whether a provider key already resolves (env or keychain). */
  hasKey(): Promise<boolean>;
  /** Masked key entry; null when the user cancels or enters nothing. */
  askSecret(): Promise<string | null>;
  /** Persist the key (keychain). */
  storeKey(value: string): Promise<void>;
  write(text: string): void;
}

export type OnboardingResult = "ready" | "cancelled";

const SET_KEY_HINT = "  glorious config set --secret providers.azure.api_key";

export async function runOnboarding(port: OnboardingPort): Promise<OnboardingResult> {
  if (await port.hasKey()) return "ready";

  port.write(
    "\nWelcome to glorious.\n\n" +
      "One thing to set up: your Azure AI Foundry API key.\n" +
      "It goes in your OS keychain, never a file.\n\n",
  );
  const key = await port.askSecret();
  if (!key || key.trim().length === 0) {
    port.write(`\nNo key entered. Set one any time with:\n${SET_KEY_HINT}\n\n`);
    return "cancelled";
  }
  await port.storeKey(key.trim());
  port.write("\nSaved to your keychain. Starting glorious…\n\n");
  return "ready";
}
