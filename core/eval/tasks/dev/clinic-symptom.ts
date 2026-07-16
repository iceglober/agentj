import type { Task } from "../../../lib/eval/types";
import { CLINIC_DEFECTS, CORRECT_FILES } from "../../fixtures/clinic";

import { seededDefects } from "../../sources/seeded-defect";

/**
 * Symptom-level single tasks: each prompt describes user-visible behavior in
 * product terms — including a domain rule the fix must honor — and never names
 * the defective file or the failing test. Locating the cause is the task.
 */
const tasks: Task[] = seededDefects({
  idPrefix: "clinic",
  base: CORRECT_FILES,
  prompt: "unused: every defect carries its own symptom prompt",
  defects: [
    CLINIC_DEFECTS.bannerForPartners,
    CLINIC_DEFECTS.setupRedirect,
    CLINIC_DEFECTS.navLeak,
    CLINIC_DEFECTS.flagOverride,
  ],
  tags: ["ambiguity:symptom"],
});

export default tasks;
