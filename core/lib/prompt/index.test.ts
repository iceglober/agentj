import { describe, expect, test } from "bun:test";
import {
  composePrompt,
  profileNames,
  resolveProfile,
  type PromptConfig,
  type PromptContext,
  type PromptInputs,
} from "./index";
import { renderTemplate } from "./render";

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
    const on = composePrompt(AUTO, inputs({ model: "gpt-5.6-luna" }), CTX);
    expect(on.flags.planning).toBe(true);
    expect(on.instructions).toContain("2. Plan:");

    const off = composePrompt(
      { profile: "auto", flags: { planning: false } },
      inputs({ model: "gpt-5.6-luna" }),
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

  test("9. no residual {{ across every profile × role", () => {
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
});

describe("renderTemplate", () => {
  test("10a. nested if/unless collapse innermost-first", () => {
    const tpl = "A{{#if OUTER}}[{{#unless INNER}}x{{/unless}}]{{/if}}B";
    expect(renderTemplate(tpl, {}, { OUTER: true, INNER: false })).toBe("A[x]B");
    expect(renderTemplate(tpl, {}, { OUTER: true, INNER: true })).toBe("A[]B");
    expect(renderTemplate(tpl, {}, { OUTER: false, INNER: true })).toBe("AB");
  });

  test("10b. throws on unknown flag and unknown var", () => {
    expect(() => renderTemplate("{{#if NOPE}}x{{/if}}", {}, {})).toThrow(/unknown flag/);
    expect(() => renderTemplate("{{NOPE}}", {}, {})).toThrow(/unknown var/);
  });

  test("10c. substitutes vars and collapses 3+ newlines", () => {
    expect(renderTemplate("hi {{NAME}}\n\n\n\nbye", { NAME: "bo" }, {})).toBe("hi bo\n\nbye");
  });
});
