import { taskSchema } from "../../../lib/eval/types";
import { CORRECT_FILES } from "../../fixtures/clinic";

/**
 * Read-only synthesis: the right outcome is NO diff plus a specific answer
 * assembled from docs/migration.md and the code. diff_scope with an empty
 * allow-list makes any edit a failure; report_contains is the oracle.
 */
const task = taskSchema.parse({
  id: "clinic-next-steps",
  prompt:
    "Based on docs/migration.md and the current code, what are my next steps on the " +
    "flags migration, specifically? Don't change anything — just tell me.",
  fixture: { kind: "inline", files: CORRECT_FILES },
  checks: [
    { kind: "report_contains", id: "next-steps", contains: ["audit", "legacy_flags"] },
    { kind: "diff_scope", id: "read-only", allow: [] },
  ],
  reference: {
    report:
      "Two steps remain: (1) emit an audit event whenever a per-org override changes — " +
      "blocked on writing the events module first; (2) retire the legacy_flags fallback " +
      "in is_enabled and delete Org.legacy_flags once no Org constructor passes it.",
  },
  timeoutSec: 420,
  budget: { steps: 15 },
  tags: ["synthesis", "read-only"],
});

export default task;
