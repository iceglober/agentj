import type { Task } from "../../../lib/eval/types";
import { CORRECT_FILES, OPS_DEFECTS } from "../../fixtures/ops";
import { seededDefects } from "../../sources/seeded-defect";

/**
 * TypeScript symptom-voice fixes: same shape as the clinic symptom tasks, in
 * the language AgentJ itself is written in. Tests run with bun.
 */
const tasks: Task[] = seededDefects({
  idPrefix: "ops",
  base: CORRECT_FILES,
  prompt: "unused: every defect carries its own symptom prompt",
  defects: [OPS_DEFECTS.digestBoundary, OPS_DEFECTS.seedDupes],
  checks: [
    { kind: "test_command", id: "tests", command: "bun tests.ts", resetPaths: ["tests.ts"] },
    { kind: "diff_scope", id: "scope", allow: ["src/**", "bin/**", "*.ts"] },
  ],
  tags: ["ambiguity:symptom", "typescript"],
});

export default tasks;
