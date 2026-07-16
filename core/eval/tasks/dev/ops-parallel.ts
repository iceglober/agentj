import type { Task } from "../../../lib/eval/types";
import { CORRECT_FILES, OPS_DEFECTS } from "../../fixtures/ops";
import { punchList } from "../../sources/seeded-defect";

/**
 * Delegation under test: three independent fixes and an explicit ask to fan
 * out with subagents. The required tool_usage check observes the trajectory —
 * the in-process adapter wires run_subagents exactly like the production
 * builder, so this validates the delegation path end to end.
 */
const task: Task = punchList({
  id: "ops-parallel",
  base: CORRECT_FILES,
  intro:
    "Three independent fixes — they don't overlap at all, so fan them out with subagents " +
    "and run them in parallel:",
  defects: [OPS_DEFECTS.digestBoundary, OPS_DEFECTS.seedDupes, OPS_DEFECTS.reminderFormat],
  sharedChecks: [
    { kind: "test_command", id: "tests", command: "bun tests.ts", resetPaths: ["tests.ts"] },
    { kind: "diff_scope", id: "scope", allow: ["src/**", "bin/**", "*.ts"] },
    { kind: "tool_usage", id: "delegated", required: true, tool: "run_subagents", min: 1 },
  ],
  referenceToolCalls: ["run_subagents"],
  tags: ["delegation", "typescript"],
});

export default task;
