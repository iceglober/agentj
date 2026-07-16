import type { Task } from "../../../lib/eval/types";
import { CLINIC_DEFECTS, CORRECT_FILES } from "../../fixtures/clinic";
import { seededDefects } from "../../sources/seeded-defect";

/**
 * Context discovery: the prompt is three words. Everything needed — the
 * requirements and acceptance criteria — lives in tickets/TCK-31.md inside the
 * fixture. Grading observes final file content, so wording is the oracle.
 */
const tasks: Task[] = seededDefects({
  idPrefix: "clinic-ticket",
  base: CORRECT_FILES,
  prompt: "unused: the defect carries the terse prompt",
  defects: [CLINIC_DEFECTS.draftMfaCopy],
  checks: [
    {
      kind: "file_state",
      id: "approved-copy",
      path: "templates.py",
      required: true,
      contains: ["sign-in code"],
      absent: ["unintended consequences"],
    },
    {
      kind: "test_command",
      id: "tests",
      required: true,
      command: "python3 tests.py",
      expectExit: 0,
      resetPaths: ["tests.py"],
    },
    { kind: "diff_scope", id: "scope", required: true, allow: ["templates.py"] },
  ],
  tags: ["context-discovery", "terse"],
});

export default tasks;
