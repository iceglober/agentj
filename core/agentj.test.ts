import { describe, expect, test } from "bun:test";
import config from "./agentj";
import { agentConfigSchema } from "./lib/agent";

describe("bundled config", () => {
  test("includes the architecture and checking-your-work reflections", () => {
    const prompts = agentConfigSchema.parse(config.agent).reflections.prompts;

    expect(Object.keys(prompts)).toEqual(["architecture", "checking-your-work"]);
    expect(prompts["checking-your-work"]).toBe(
      "Ensure you outline how we will prove the work is correct. Reproduce the root cause for bugs, name focused and broad checks, inspect the final result, and include browser testing when relevant. State what each check proves and call out any check that cannot run.",
    );
  });
});
