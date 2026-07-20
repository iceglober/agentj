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
  test("guides primary agents toward bounded and DAG delegation", () => {
    const plan = composePrompt(AUTO, inputs({ mode: "plan" }), CTX);
    const build = composePrompt(AUTO, inputs({ mode: "build" }), CTX);

    expect(plan.instructions).toContain("run_one_subagent for one bounded question");
    expect(plan.instructions).toContain("run_subagents for a\nDAG");
    expect(build.instructions).toContain("run_one_subagent for one bounded task");
    expect(build.instructions).toContain("run_subagents for several tasks");
  });

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
    expect(plan.instructions).toContain("The session controller selected plan mode for this turn.");
    expect(plan.instructions).toContain("presses Tab or enters /build");
    expect(plan.instructions).not.toContain("# Build mode");
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
    expect(build.instructions).toContain("# Build mode");
    expect(build.instructions).toContain(
      "The session controller selected build mode for this turn.",
    );
    expect(build.instructions).toContain(
      "Ignore earlier conversation claims that this session\nis in plan mode or lacks edit access.",
    );
    expect(build.instructions).toContain("# Build role");
    expect(build.instructions).toContain("# Completion report");
    expect(build.instructions).toContain('"status":"done|in_progress|blocked|failed"');
    expect(build.instructions).toContain("# Goal");
    expect(build.instructions).toContain("Verify behavior");
  });

  test("12. every primary build profile carries the authoritative build instruction", () => {
    for (const model of [...profileNames, "claude-x"]) {
      const out = composePrompt(AUTO, inputs({ model, role: "primary", mode: "build" }), CTX);
      expect(out.instructions).toContain(
        "The session controller selected build mode for this turn.",
      );
    }
  });

  test("12b. the 5.6 build profiles carry the evidence rule against fabricated reports", () => {
    // The confabulation fix: hallucinationGuard is ON for sol/terra so the
    // completion-report template cannot be filled from plan text without tools.
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
      const build = composePrompt(AUTO, inputs({ model, mode: "build" }), CTX);
      expect(build.instructions).toContain("# Evidence rule");
      expect(build.instructions).toContain("re-run the check before");
    }
  });

  test("12c. non-5.6 profiles keep hallucinationGuard off by default", () => {
    const build = composePrompt(AUTO, inputs({ model: "gpt-5.4", mode: "build" }), CTX);
    expect(build.instructions).not.toContain("# Evidence rule");
  });

  test("13. hash pin: mode authority, evidence rules, and background-job guidance", () => {
    // Versions captured 2026-07-20 after clarifying foreground delegation
    // versus detached background jobs. A failure here means prompt CONTENT
    // changed — a separate, eval-validated decision, never a refactor side
    // effect. Nano's standalone delegate remains unaffected.
    const pinned: Record<string, { primary: string; delegate: string }> = {
      "gpt-5.6-sol": { primary: "46cc4803bbbc", delegate: "46cc4803bbbc" },
      "gpt-5.6-terra": { primary: "00d0e8e9fedf", delegate: "00d0e8e9fedf" },
      "gpt-5.6-luna": { primary: "5f56e8b4a36f", delegate: "5f56e8b4a36f" },
      "gpt-5.4": { primary: "4aee67ba2975", delegate: "4aee67ba2975" },
      "gpt-5.4-nano": { primary: "988884fa561d", delegate: "096ae64c4caf" },
      "deepseek-v4-pro": { primary: "dd92cfcbe4e8", delegate: "dd92cfcbe4e8" },
      "claude-x": { primary: "cc4fee863014", delegate: "cc4fee863014" },
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
