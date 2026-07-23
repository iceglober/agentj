import { describe, expect, test } from "bun:test";
import { type OnboardingPort, runOnboarding } from "./onboarding";

const makePort = (
  over: Partial<OnboardingPort> & { key?: string | null },
): {
  port: OnboardingPort;
  out: string[];
  stored: string[];
} => {
  const out: string[] = [];
  const stored: string[] = [];
  const port: OnboardingPort = {
    hasKey: over.hasKey ?? (async () => false),
    askSecret: over.askSecret ?? (async () => over.key ?? null),
    storeKey: async (value) => {
      stored.push(value);
    },
    write: (text) => out.push(text),
  };
  return { port, out, stored };
};

describe("runOnboarding", () => {
  test("does nothing when a key already resolves", async () => {
    const { port, out, stored } = makePort({ hasKey: async () => true });
    expect(await runOnboarding(port)).toBe("ready");
    expect(out).toEqual([]);
    expect(stored).toEqual([]);
  });

  test("stores an entered key and proceeds", async () => {
    const { port, out, stored } = makePort({ key: "  sk-abc  " });
    expect(await runOnboarding(port)).toBe("ready");
    expect(stored).toEqual(["sk-abc"]); // trimmed
    expect(out.join("")).toContain("Welcome to glorious");
    expect(out.join("")).toContain("Saved to your keychain");
  });

  test("cancelling leaves guidance and does not store", async () => {
    const { port, out, stored } = makePort({ key: null });
    expect(await runOnboarding(port)).toBe("cancelled");
    expect(stored).toEqual([]);
    expect(out.join("")).toContain("glorious config set --secret");
  });

  test("a blank key counts as cancel", async () => {
    const { port, stored } = makePort({ key: "   " });
    expect(await runOnboarding(port)).toBe("cancelled");
    expect(stored).toEqual([]);
  });
});
