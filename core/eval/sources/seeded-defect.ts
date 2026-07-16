import type z from "zod";
import { type checkSchema, type Task, taskSchema } from "../../lib/eval/types";

/** Author-facing check shape: schema input, so defaulted fields stay optional. */
export type CheckInput = z.input<typeof checkSchema>;

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
  /**
   * User-voice prompt for this defect (a symptom description, not an oracle).
   * Falls back to the source-level prompt when absent.
   */
  prompt?: string;
}

export interface SeededDefectsOpts {
  /** Task ids become `${idPrefix}-${defect.id}`. */
  idPrefix: string;
  /** A known-correct file map; every defect's `find` must occur in `base[file]`. */
  base: Record<string, string>;
  /** Default prompt for derived tasks; a defect's own `prompt` takes precedence. */
  prompt: string;
  defects: Defect[];
  /** Override the default checks (test_command + diff_scope). */
  checks?: CheckInput[];
  /** Extra tags beyond "seeded" (e.g. an ambiguity level). */
  tags?: string[];
}

const DEFAULT_CHECKS = (): unknown[] => [
  { kind: "test_command", id: "tests", command: "python3 tests.py", resetPaths: ["tests.py"] },
  { kind: "diff_scope", id: "scope", allow: ["*.py", "**/*.py"] },
];

/** Assert a defect applies cleanly to the base, returning the bugged file map. */
function applyDefect(base: Record<string, string>, d: Defect): Record<string, string> {
  const original = base[d.file];
  if (original === undefined)
    throw new Error(`seeded defect "${d.id}" targets unknown file "${d.file}"`);
  if (!original.includes(d.find))
    throw new Error(
      `seeded defect "${d.id}" find-string not present in "${d.file}"` +
        (d.note ? ` (${d.note})` : ""),
    );
  return { ...base, [d.file]: original.replace(d.find, d.replace) };
}

/**
 * Turn a correct base map + a list of single-bug defects into one Task each.
 * Throws at load if a defect's `find` is not present in its file — the fixture
 * QA gate that keeps a stale defect from silently producing an unsolvable task.
 */
export function seededDefects(opts: SeededDefectsOpts): Task[] {
  const { idPrefix, base, prompt, defects, checks, tags = [] } = opts;
  return defects.map((d) => {
    const fixture = applyDefect(base, d);
    return taskSchema.parse({
      id: `${idPrefix}-${d.id}`,
      prompt: d.prompt ?? prompt,
      fixture: { kind: "inline", files: fixture },
      checks: checks ?? DEFAULT_CHECKS(),
      tags: ["seeded", ...tags],
      timeoutSec: 420,
      budget: { steps: 20 },
      // Restoring just this file to its correct content proves the task solvable.
      reference: { files: { [d.file]: base[d.file]! } },
    });
  });
}

/** One numbered item of a punch list beyond the seeded defects. */
export interface PunchListItem {
  /** The numbered line shown to the agent, in the user's voice. */
  text: string;
  /** The check that grades this item. */
  check: CheckInput;
}

export interface PunchListOpts {
  id: string;
  /** A known-correct file map; defects are injected into it. */
  base: Record<string, string>;
  /** Conversational preamble before the numbered items. */
  intro: string;
  /** Defects to inject; each contributes its `prompt` as a numbered item. */
  defects: Defect[];
  /** Non-defect items (copy changes, removals, embedded questions, …). */
  items?: PunchListItem[];
  /** Checks that grade the whole task rather than one item. */
  sharedChecks?: CheckInput[];
  /** Reference report satisfying any report-based item checks. */
  referenceReport?: string;
  /** Reference file overrides for non-defect items (merged over the base). */
  referenceFiles?: Record<string, string>;
  tags?: string[];
}

/**
 * Compose several defects and free-form items into ONE multi-item task with a
 * numbered, user-voice prompt — the punch-list shape real requests arrive in.
 * Each item is graded by its own check, so `fails`/subscores show per-item
 * coverage rather than a single all-or-nothing verdict.
 */
export function punchList(opts: PunchListOpts): Task {
  const {
    id,
    base,
    intro,
    defects,
    items = [],
    sharedChecks = [],
    referenceReport,
    referenceFiles = {},
    tags = [],
  } = opts;

  // Inject every defect into one fixture; each must apply cleanly.
  let fixture = base;
  for (const d of defects) fixture = applyDefect(fixture, d);

  const lines = [
    ...defects.map((d) => {
      if (!d.prompt)
        throw new Error(`punchList "${id}": defect "${d.id}" needs a user-voice prompt`);
      return d.prompt;
    }),
    ...items.map((i) => i.text),
  ];
  const prompt = `${intro}\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

  // The reference restores every defective file and applies item overrides.
  const restored = Object.fromEntries(defects.map((d) => [d.file, base[d.file]!]));

  return taskSchema.parse({
    id,
    prompt,
    fixture: { kind: "inline", files: fixture },
    checks: [...items.map((i) => i.check), ...sharedChecks],
    tags: ["punch-list", ...tags],
    timeoutSec: 600,
    budget: { steps: 40 },
    reference: {
      files: { ...restored, ...referenceFiles },
      ...(referenceReport ? { report: referenceReport } : {}),
    },
  });
}
