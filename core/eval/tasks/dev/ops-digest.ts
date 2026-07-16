import { taskSchema } from "../../../lib/eval/types";
import { CORRECT_FILES, REFERENCE_NEXT_DIGEST } from "../../fixtures/ops";

/**
 * Recurring-task-by-convention: "the next weekly digest" is defined entirely
 * by repo context — the previous digest under docs/digests/ shows the format
 * and cadence, data/entries.json holds the source data. Grading checks the
 * right items landed in the right week and the out-of-window items did not.
 */
const task = taskSchema.parse({
  id: "ops-digest",
  prompt: "I need you to create the next weekly digest.",
  fixture: { kind: "inline", files: CORRECT_FILES },
  checks: [
    {
      kind: "file_state",
      id: "digest-content",
      path: "docs/digests/2026-07-13.md",
      contains: [
        "Week of 2026-07-13",
        "Bulk claim export beta",
        "Sandbox environment refreshed",
        "Rotated portal credentials",
      ],
      absent: ["Assistant labels finalized", "Payer mapping editor shipped"],
    },
    { kind: "diff_scope", id: "scope", allow: ["docs/digests/**"] },
  ],
  reference: { files: { "docs/digests/2026-07-13.md": REFERENCE_NEXT_DIGEST } },
  timeoutSec: 420,
  budget: { steps: 15 },
  tags: ["ops", "terse", "recurring"],
});

export default task;
