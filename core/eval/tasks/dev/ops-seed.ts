import { taskSchema } from "../../../lib/eval/types";
import { CORRECT_FILES } from "../../fixtures/ops";

/**
 * Cross-environment data task: dev was seeded earlier (visible in
 * data/dev.json); the prompt asks for the same in sandbox, by reference to
 * that prior work. The tenant store is a mocked external system — JSON files
 * per environment plus the bin/seed.ts CLI.
 */
const task = taskSchema.parse({
  id: "ops-seed-sandbox",
  prompt:
    "Take a look at how we seeded the dev environment and do the same in sandbox for " +
    'tenant "Acme Sales Enablement".',
  fixture: { kind: "inline", files: CORRECT_FILES },
  checks: [
    {
      kind: "file_state",
      id: "tenant-seeded",
      path: "data/sandbox.json",
      contains: ["Acme Sales Enablement", '"plan": "standard"'],
    },
    { kind: "test_command", id: "tests", command: "bun tests.ts", resetPaths: ["tests.ts"] },
    { kind: "diff_scope", id: "scope", allow: ["data/sandbox.json"] },
  ],
  reference: { command: "bun bin/seed.ts sandbox 'Acme Sales Enablement'" },
  timeoutSec: 420,
  budget: { steps: 15 },
  tags: ["ops", "context-discovery", "mock-external"],
});

export default task;
