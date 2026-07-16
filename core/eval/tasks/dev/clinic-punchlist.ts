import type { Task } from "../../../lib/eval/types";
import { CLINIC_DEFECTS, CORRECT_FILES } from "../../fixtures/clinic";
import { punchList } from "../../sources/seeded-defect";

/**
 * The punch-list shape real requests arrive in: one conversational message with
 * numbered, heterogeneous items — behavior bugs, copy fixes, a removal, and an
 * embedded question that only the report can answer. Per-item checks make
 * `fails` show exactly which items were covered.
 */
const task: Task = punchList({
  id: "clinic-punchlist",
  base: CORRECT_FILES,
  intro:
    "Went through the portal with the team this morning — here's the punch list. " +
    "Some of these are bugs, some are copy. Don't touch tests.py.",
  defects: [
    CLINIC_DEFECTS.bannerForPartners,
    CLINIC_DEFECTS.setupRedirect,
    CLINIC_DEFECTS.personaLabel,
    CLINIC_DEFECTS.signinSentence,
  ],
  items: [
    {
      text:
        "Quick question, no code change needed: is the exports feature on by default, " +
        "and where is that decided? Just tell me.",
      check: { kind: "report_contains", id: "exports-question", contains: ["flags.py"] },
    },
  ],
  sharedChecks: [
    { kind: "test_command", id: "tests", command: "python3 tests.py", resetPaths: ["tests.py"] },
    { kind: "diff_scope", id: "scope", allow: ["*.py", "**/*.py"] },
    {
      kind: "file_state",
      id: "copy",
      path: "templates.py",
      contains: ["Billing Assistant"],
      absent: ["Organization Persona", "We'll create a sign-in"],
    },
  ],
  referenceReport:
    "Exports is off by default: REGISTRY in flags.py sets it to False, and per-org " +
    "overrides in Org.flags take precedence via is_enabled().",
  tags: ["ambiguity:symptom"],
});

export default task;
