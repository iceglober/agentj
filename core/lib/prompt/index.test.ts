import { describe, expect, test } from "bun:test";
import {
  composePrompt,
  type PromptConfig,
  type PromptContext,
  type PromptInputs,
  profileNames,
  resolveProfile,
} from "./index";

const CTX: PromptContext = {
  cwd: "/repo",
  os: "darwin",
  date: "2026-07-12",
  gitBranch: "main",
  gitStatusSummary: "clean",
};

const inputs = (over: Partial<PromptInputs> = {}): PromptInputs => ({
  model: "claude-x",
  agentName: "agentj",
  role: "primary",
  rules: "- be nice",
  ...over,
});

const AUTO: PromptConfig = { profile: "auto" };

/** Everything above `# Project rules` — the cacheable, session-stable prefix. */
const prefix = (s: string) => s.slice(0, s.indexOf("# Project rules"));

describe("composePrompt", () => {
  test("1. deterministic: same inputs → identical instructions + version", () => {
    const a = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX);
    const b = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX);
    expect(a.instructions).toBe(b.instructions);
    expect(a.version).toBe(b.version);
  });

  test("2. caching contract: changing only ctx keeps the prefix AND the version", () => {
    const base = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX);
    const moved = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), {
      ...CTX,
      cwd: "/elsewhere",
      date: "2027-01-01",
    });
    expect(prefix(moved.instructions)).toBe(prefix(base.instructions));
    // Version identifies prompt content, not the trial: the volatile
    // `# Environment` footer is excluded, so ctx changes don't move it...
    expect(moved.version).toBe(base.version);
    // ...but content changes (rules feed {{PROJECT_RULES}}) do.
    const ruled = composePrompt(
      AUTO,
      inputs({ model: "gpt-5.6-sol", rules: "Always use tabs." }),
      CTX,
    );
    expect(ruled.version).not.toBe(base.version);
  });

  test("3. auto-resolution maps model ids to profiles", () => {
    expect(resolveProfile("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveProfile("gpt-5.6-sol-2")).toBe("gpt-5.6-sol");
    expect(resolveProfile("gpt-5.4-nano")).toBe("gpt-5.4-nano");
    expect(resolveProfile("gpt-5.4-turbo")).toBe("gpt-5.4");
    expect(resolveProfile("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveProfile("claude-x")).toBeNull();

    const fallback = composePrompt(AUTO, inputs({ model: "claude-x" }), CTX);
    expect(fallback.profile).toBe("default");
    expect(fallback.instructions).toContain("You are agentj");
    expect(fallback.instructions).not.toContain("{{");
  });

  test("4. flag precedence: config overrides profile", () => {
    const on = composePrompt(AUTO, inputs({ model: "gpt-5.4-nano" }), CTX);
    expect(on.flags.planning).toBe(true);
    expect(on.instructions).toContain("2. Plan:");

    const off = composePrompt(
      { profile: "auto", flags: { planning: false } },
      inputs({ model: "gpt-5.4-nano" }),
      CTX,
    );
    expect(off.flags.planning).toBe(false);
    expect(off.instructions).not.toContain("2. Plan:");
  });

  test("5. subagent contract swaps out the comms/stop rules", () => {
    const on = composePrompt(
      { profile: "auto", flags: { subagentContract: true } },
      inputs({ model: "claude-x" }),
      CTX,
    );
    expect(on.instructions).toContain("# Subagent contract");
    expect(on.instructions).not.toContain("# Communication");
    expect(on.instructions).not.toContain("# Stop rules");

    const off = composePrompt(AUTO, inputs({ model: "claude-x" }), CTX);
    expect(off.instructions).toContain("# Communication");
    expect(off.instructions).toContain("# Stop rules");
    expect(off.instructions).not.toContain("# Subagent contract");
  });

  test("6. sol variant is outcome-first but keeps the verify tail", () => {
    const sol = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX);
    expect(sol.instructions).toContain("# Goal");
    expect(sol.instructions).toContain("# Success criteria");
    expect(sol.instructions).toContain("# Judgment");
    expect(sol.instructions).not.toContain("1. Understand");
    expect(sol.instructions).toContain("Verify behavior");
    expect(sol.instructions).toContain("Verify standards");
  });

  test("7. nano: delegate → executor, primary → base with discipline + contract", () => {
    const delegate = composePrompt(AUTO, inputs({ model: "gpt-5.4-nano", role: "delegate" }), CTX);
    expect(delegate.instructions.startsWith("You are a coding executor")).toBe(true);

    const primary = composePrompt(AUTO, inputs({ model: "gpt-5.4-nano" }), CTX);
    expect(primary.instructions.startsWith("You are agentj")).toBe(true);
    expect(primary.instructions).toContain("# Execution discipline");
    expect(primary.instructions).toContain("# Subagent contract");
  });

  test("8. params pass through from the profile", () => {
    const deepseek = composePrompt(AUTO, inputs({ model: "deepseek-v4-pro" }), CTX);
    expect(deepseek.params).toEqual({ temperature: 1, topP: 1 });

    const sol = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX);
    expect(sol.params.providerOptions?.openai?.reasoningEffort).toBe("high");
  });

  test("9. marks known non-vision profiles", () => {
    expect(composePrompt(AUTO, inputs({ model: "deepseek-v4-pro" }), CTX).supportsImages).toBe(
      false,
    );
    expect(composePrompt(AUTO, inputs({ model: "gpt-5.6-sol" }), CTX).supportsImages).toBe(true);
  });

  test("10. no residual {{ across every profile × role", () => {
    for (const name of [...profileNames, "claude-x"]) {
      for (const role of ["primary", "delegate"] as const) {
        const out = composePrompt(
          AUTO,
          inputs({ model: name, role, outputSchema: "MyResult" }),
          CTX,
        );
        expect(out.instructions.includes("{{")).toBe(false);
      }
    }
  });

  test("11. mode composes orthogonally with model profiles", () => {
    const plan = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol", mode: "plan" }), CTX);
    expect(plan.instructions).toContain("# Plan mode");
    expect(plan.instructions).toContain("presses Tab or enters /build");
    expect(plan.instructions).not.toContain("# Build role");
    expect(plan.instructions).not.toContain("# Goal");
    expect(plan.instructions).not.toContain("Verify behavior");

    const research = composePrompt(
      AUTO,
      inputs({ model: "gpt-5.4-nano", role: "delegate", mode: "plan" }),
      CTX,
    );
    expect(research.instructions).toContain("# Research role");
    expect(research.instructions.startsWith("You are a coding executor")).toBe(false);

    const build = composePrompt(AUTO, inputs({ model: "gpt-5.6-sol", mode: "build" }), CTX);
    expect(build.instructions).toContain("# Build role");
    expect(build.instructions).toContain("# Completion report");
    expect(build.instructions).toContain('"status":"done|blocked|failed"');
    expect(build.instructions).toContain("# Goal");
    expect(build.instructions).toContain("Verify behavior");
  });

  test("12. hash pin: background-job rules are reflected in build prompts", () => {
    // Versions captured 2026-07-20 after the background-job invariant was
    // added. A failure here means prompt CONTENT changed — a separate,
    // eval-validated decision, never a refactor side effect. Nano's delegate
    // uses its standalone template and is unaffected.
    const pinned: Record<string, { primary: string; delegate: string }> = {
      "gpt-5.6-sol": { primary: "e27e5fdb0631", delegate: "e27e5fdb0631" },
      "gpt-5.6-terra": { primary: "7c041060ebc9", delegate: "7c041060ebc9" },
      "gpt-5.6-luna": { primary: "4620ac948ff0", delegate: "4620ac948ff0" },
      "gpt-5.4": { primary: "ceed668e1dab", delegate: "ceed668e1dab" },
      "gpt-5.4-nano": { primary: "d90b0d6ad9a2", delegate: "096ae64c4caf" },
      "deepseek-v4-pro": { primary: "a1281c4d09c0", delegate: "a1281c4d09c0" },
      "claude-x": { primary: "ee811fde8f7f", delegate: "ee811fde8f7f" },
    };
    const pinCtx = {
      cwd: "/repo",
      os: "linux",
      date: "2026-01-01",
      gitBranch: "main",
      gitStatusSummary: "clean",
    };
    for (const [model, expected] of Object.entries(pinned)) {
      const primary = composePrompt(
        AUTO,
        inputs({ model, role: "primary", rules: "", mode: "build" }),
        pinCtx,
      );
      const delegate = composePrompt(
        AUTO,
        inputs({ model, role: "delegate", rules: "", mode: "build" }),
        pinCtx,
      );
      expect(`${model}:${primary.version}`).toBe(`${model}:${expected.primary}`);
      expect(`${model}:${delegate.version}`).toBe(`${model}:${expected.delegate}`);
    }
  });
});
