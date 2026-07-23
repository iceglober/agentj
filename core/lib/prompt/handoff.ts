/**
 * The plan→build handoff seed. The builder starts on a fresh model context
 * carrying only the original task and the approved plan — not the planner's
 * conversation history — and is told to verify and correct the plan rather than
 * anchor on it. Benchmark evidence (findings-2026-07-23) showed this clean
 * handoff recovers planner-quality results at builder cost.
 */
export function buildHandoffPrompt(
  task: string | null,
  plan: string | null,
  feedback?: string,
): string {
  const parts: string[] = [];
  if (task?.trim()) parts.push(`<task>\n${task.trim()}\n</task>`);
  if (plan?.trim()) parts.push(`<approved-plan>\n${plan.trim()}\n</approved-plan>`);
  parts.push(
    "Implement the approved plan. As you work, verify each step against the repository and correct the plan where the evidence differs — the plan is a starting point, not an infallible spec. Complete the change and validate it end to end.",
  );
  if (feedback?.trim()) parts.push(`Additional feedback from the user: ${feedback.trim()}`);
  return parts.join("\n\n");
}
