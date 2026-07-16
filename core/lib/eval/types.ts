import z from "zod";
import type { SandboxCommandResult } from "../sandbox";

// Contract 1: Task — immutable once frozen; a task without an executable check is a prompt, not a task.
export const fixtureRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), files: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("dir"), path: z.string() }), // host dir; composition root reads + writeFiles
]);
export type FixtureRef = z.infer<typeof fixtureRefSchema>;

export const checkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("test_command"),
    id: z.string(),
    required: z.boolean().default(true),
    command: z.string(),
    expectExit: z.number().int().default(0),
    /** Paths re-written from the fixture before running, so editing them can't game the grade. */
    resetPaths: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("diff_scope"),
    id: z.string(),
    required: z.boolean().default(true),
    allow: z.array(z.string()),
  }), // changed paths must all match some allow glob
  z.object({
    kind: z.literal("no_placeholder"),
    id: z.string(),
    required: z.boolean().default(false),
    patterns: z.array(z.string()).default(["TODO", "FIXME", "XXX", "NotImplementedError", "..."]),
  }),
  z.object({
    kind: z.literal("no_new_deps"),
    id: z.string(),
    required: z.boolean().default(false),
    manifests: z
      .array(z.string())
      .default(["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"]),
  }),
  z.object({
    kind: z.literal("diff_size"),
    id: z.string(),
    required: z.boolean().default(false),
    maxChangedLines: z.number().int(),
  }),
  z.object({
    kind: z.literal("file_state"),
    id: z.string(),
    required: z.boolean().default(true),
    path: z.string(),
    /** Substrings that must appear in the file's final content. */
    contains: z.array(z.string()).default([]),
    /** Substrings that must NOT appear in the file's final content. */
    absent: z.array(z.string()).default([]),
  }), // observes final file content — removals, copy changes, negative constraints
  z.object({
    kind: z.literal("report_contains"),
    id: z.string(),
    required: z.boolean().default(true),
    /** Case-insensitive substrings that must appear in the agent's final report. */
    contains: z.array(z.string()).min(1),
  }), // observes the final report — embedded questions, synthesis tasks
  z.object({
    kind: z.literal("tool_usage"),
    id: z.string(),
    required: z.boolean().default(false),
    tool: z.string(),
    min: z.number().int().default(1),
    max: z.number().int().optional(),
  }), // observes the trajectory — did the agent use a capability (e.g. run_subagents)?
  z.object({
    kind: z.literal("judge"),
    id: z.string(),
    required: z.boolean().default(false),
    rubric: z.string(),
  }),
]);
export type Check = z.infer<typeof checkSchema>;

export const verdictEnum = z.enum(["pass", "fail", "error", "timeout"]);
export type Verdict = z.infer<typeof verdictEnum>;

export const taskSchema = z.object({
  id: z.string(),
  version: z.number().int().default(1),
  prompt: z.string(),
  fixture: fixtureRefSchema,
  checks: z.array(checkSchema).min(1),
  tags: z.array(z.string()).default([]),
  timeoutSec: z.number().default(600),
  budget: z
    .object({
      tokensIn: z.number().optional(),
      usd: z.number().optional(),
      steps: z.number().int().default(40),
    })
    .prefault({}),
  /** Task-QA gate: reference solution proves solvable; a no-op run must fail (falsifiable). */
  reference: z
    .object({
      files: z.record(z.string(), z.string()).optional(),
      command: z.string().optional(),
      /** Reference final report, so report-based checks stay covered by the QA gate. */
      report: z.string().optional(),
      /** Reference tool-call names, so trajectory-based checks stay covered by the QA gate. */
      toolCalls: z.array(z.string()).optional(),
    })
    .optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const taskKey = (t: Task) => `${t.id}@${t.version}`;

// Contract 2: Env — hermetic, disposable, fresh per trial.
export interface Env extends AsyncDisposable {
  readonly id: string;
  readonly dir: string;
  exec(command: string): Promise<SandboxCommandResult>;
  writeFiles(files: { path: string; content: string }[]): Promise<void>;
  diff(): Promise<string>; // unified diff vs the frozen fixture baseline
  changedFiles(): Promise<string[]>; // repo-relative paths
  destroy(): Promise<void>;
}
export interface FixtureFactory {
  make(ref: FixtureRef): Promise<Env>;
}

// Contract 5: Trajectory — sufficient to diagnose a failure without rerunning.
// `usage` is a rollup (includes future nested runs); subTrajectories reserved for a future subagent concept.
export interface Trajectory {
  toolCalls: { step: number; name: string; input: unknown }[];
  toolResults: { step: number; name: string; output: unknown; isError?: boolean }[];
  finalText: string;
  finalDiff: string;
  filesTouched: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: number;
  wallMs: number;
  promptVersion?: string;
  timedOut?: boolean;
  error?: string; // adapter/harness failure → verdict "error"
  subTrajectories?: Trajectory[];
}

// Contract 4: AgentAdapter — the agent behind one function. RunConfig is defined in ./config (later);
// keep the adapter generic over its config type to avoid a circular dependency.
export interface AgentAdapter<C> {
  readonly name: string;
  run(task: Task, env: Env, config: C): Promise<Trajectory>;
}

// Contract 6: Grader
export interface CheckResult {
  id: string;
  kind: Check["kind"];
  required: boolean;
  pass: boolean;
  score?: number;
  detail: string;
  skipped?: boolean;
}
export interface GradeResult {
  verdict: Verdict;
  subscores: Record<string, number>;
  checks: CheckResult[];
}
export interface GradeCtx {
  /** LLM judge closure supplied by the composition root; null result = judge unavailable → check skipped. */
  judge: (
    rubric: string,
    diff: string,
    report: string,
  ) => Promise<{ pass: boolean; reason: string } | null>;
}
export type CheckGrader = (
  env: Env,
  task: Task,
  traj: Trajectory,
  check: Check,
  ctx: GradeCtx,
) => Promise<Omit<CheckResult, "id" | "kind" | "required">>;

// TaskSource: () → Task[]
export interface TaskSource {
  name: string;
  tasks(): Promise<Task[]>;
}
