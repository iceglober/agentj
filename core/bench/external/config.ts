export const pilotTaskIds = [
  "django__django-11179",
  "sympy__sympy-13647",
  "pallets__flask-5014",
  "pytest-dev__pytest-7571",
  "matplotlib__matplotlib-23314",
] as const;

export const benchmarkArms = [
  { id: "agentj-luna", model: "gpt-5.6-luna", priceProvider: "azure" },
  { id: "codex-sol", model: "gpt-5.6-sol", priceProvider: "azure" },
  { id: "claude-opus-4.7", model: "claude-opus-4-7", priceProvider: "anthropic" },
  { id: "claude-fable-5", model: "claude-fable-5", priceProvider: "anthropic" },
  { id: "opencode-luna", model: "gpt-5.6-luna", priceProvider: "azure" },
] as const;

export type ArmId = (typeof benchmarkArms)[number]["id"];

export const benchmarkPrompt = (problem: string): string => `Fix the repository issue below.
Work directly in the repository. Inspect the relevant code, implement the smallest complete fix,
and run focused tests when practical. Do not only explain the solution. Do not commit changes.

Issue:
${problem}`;

export const RUN_TIMEOUT_MS = 20 * 60_000;
