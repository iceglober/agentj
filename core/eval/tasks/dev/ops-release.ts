import { taskSchema } from "../../../lib/eval/types";
import { CORRECT_FILES } from "../../fixtures/ops";

/**
 * Mocked external system: the "release pipeline" is bin/release, which records
 * each invocation in .release-log. The prompt is slash-command terse; the
 * runbook (docs/release.md) holds the procedure. Grading observes the recorded
 * side effects, and reference.command proves the task solvable.
 */
const task = taskSchema.parse({
  id: "ops-release",
  prompt: "/release staging and production",
  fixture: { kind: "inline", files: CORRECT_FILES },
  checks: [
    {
      kind: "file_state",
      id: "audit-log",
      path: ".release-log",
      contains: ["released staging", "released production"],
    },
    { kind: "diff_scope", id: "scope", allow: [".release-log"] },
  ],
  reference: { command: "sh bin/release staging && sh bin/release production" },
  timeoutSec: 420,
  budget: { steps: 15 },
  tags: ["ops", "terse", "mock-external"],
});

export default task;
