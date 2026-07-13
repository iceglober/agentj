import { taskSchema, type Check, type Task } from "../../lib/eval/types";

/**
 * A single injected bug: replace `find` with `replace` in exactly one file of a
 * known-correct base. The reference solution is simply the original file back.
 */
export interface Defect {
  id: string;
  file: string;
  find: string;
  replace: string;
  note?: string;
}

export interface SeededDefectsOpts {
  /** Task ids become `${idPrefix}-${defect.id}`. */
  idPrefix: string;
  /** A known-correct file map; every defect's `find` must occur in `base[file]`. */
  base: Record<string, string>;
  /** Prompt shown to the agent for every derived task. */
  prompt: string;
  defects: Defect[];
  /** Override the default checks (test_command + diff_scope). */
  checks?: Check[];
}

const DEFAULT_CHECKS = (): unknown[] => [
  { kind: "test_command", id: "tests", command: "python3 tests.py", resetPaths: ["tests.py"] },
  { kind: "diff_scope", id: "scope", allow: ["*.py", "**/*.py"] },
];

/**
 * Turn a correct base map + a list of single-bug defects into one Task each.
 * Throws at load if a defect's `find` is not present in its file — the fixture
 * QA gate that keeps a stale defect from silently producing an unsolvable task.
 */
export function seededDefects(opts: SeededDefectsOpts): Task[] {
  const { idPrefix, base, prompt, defects, checks } = opts;
  return defects.map((d) => {
    const original = base[d.file];
    if (original === undefined)
      throw new Error(`seededDefects: defect "${d.id}" targets unknown file "${d.file}"`);
    if (!original.includes(d.find))
      throw new Error(
        `seededDefects: defect "${d.id}" find-string not present in "${d.file}"` +
          (d.note ? ` (${d.note})` : ""),
      );

    const bugged = original.replace(d.find, d.replace);
    const fixture = { ...base, [d.file]: bugged };

    return taskSchema.parse({
      id: `${idPrefix}-${d.id}`,
      prompt,
      fixture: { kind: "inline", files: fixture },
      checks: checks ?? DEFAULT_CHECKS(),
      tags: ["seeded"],
      timeoutSec: 420,
      budget: { steps: 20 },
      // Restoring just this file to its correct content proves the task solvable.
      reference: { files: { [d.file]: original } },
    });
  });
}
