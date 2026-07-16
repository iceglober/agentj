import { taskSchema } from "../../../lib/eval/types";
import { BUGGY_FILES, CORRECT_FILES, OMNIBUS_PROMPT } from "../../fixtures/pricing";

/**
 * The omnibus port of ab-edit: the full 8-bug pricing package, fix them all so
 * `python3 tests.py` passes. reference.files is the fully-correct map, which
 * proves the task solvable during --selfcheck.
 */
const task = taskSchema.parse({
  id: "py-fix-pricing",
  prompt: OMNIBUS_PROMPT,
  fixture: { kind: "inline", files: BUGGY_FILES },
  checks: [
    { kind: "test_command", id: "tests", command: "python3 tests.py", resetPaths: ["tests.py"] },
    { kind: "diff_scope", id: "scope", allow: ["*.py", "**/*.py"] },
    { kind: "no_placeholder", id: "no_placeholder", required: false },
    { kind: "diff_size", id: "diff_size", required: false, maxChangedLines: 80 },
  ],
  reference: { files: CORRECT_FILES },
  timeoutSec: 600,
  budget: { steps: 30 },
  tags: ["ported", "edit", "ambiguity:explicit"],
});

export default task;
