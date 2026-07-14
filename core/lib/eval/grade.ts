import { gradeDiffScope, gradeTestCommand } from "./graders/deterministic";
import { gradeJudge } from "./graders/judge";
import { gradeDiffSize, gradeNoNewDeps, gradeNoPlaceholder } from "./graders/property";
import type {
  Check,
  CheckGrader,
  CheckResult,
  Env,
  GradeCtx,
  GradeResult,
  Task,
  Trajectory,
} from "./types";

/** Registry keyed by check kind — same idiom as `editModes`. */
export const checkGraders = {
  test_command: gradeTestCommand,
  diff_scope: gradeDiffScope,
  no_placeholder: gradeNoPlaceholder,
  no_new_deps: gradeNoNewDeps,
  diff_size: gradeDiffSize,
  judge: gradeJudge,
} satisfies Record<Check["kind"], CheckGrader>;

/**
 * Grade one trajectory against a task's checks.
 *
 * - `traj.error` → "error" with no checks (harness/adapter bug; excluded from
 *   pass rates upstream). `traj.timedOut` → "timeout".
 * - A grader that throws becomes a harness error on that check → overall "error".
 * - Verdict is "pass" iff every required, non-skipped check passes. A required
 *   check that is skipped (e.g. judge unavailable) does not count either way.
 * - subscores collect non-required, non-skipped checks by id.
 */
export async function composeGrade(
  env: Env,
  task: Task,
  traj: Trajectory,
  ctx: GradeCtx,
): Promise<GradeResult> {
  if (traj.error !== undefined) return { verdict: "error", subscores: {}, checks: [] };
  if (traj.timedOut) return { verdict: "timeout", subscores: {}, checks: [] };

  const checks: CheckResult[] = [];
  let harnessError = false;

  for (const check of task.checks) {
    const grader = checkGraders[check.kind] as CheckGrader;
    try {
      const partial = await grader(env, task, traj, check, ctx);
      checks.push({ id: check.id, kind: check.kind, required: check.required, ...partial });
    } catch (e) {
      harnessError = true;
      checks.push({
        id: check.id,
        kind: check.kind,
        required: check.required,
        pass: false,
        detail: `grader error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (harnessError) return { verdict: "error", subscores: {}, checks };

  const requiredOk = checks.filter((c) => c.required && !c.skipped).every((c) => c.pass);

  const subscores: Record<string, number> = {};
  for (const c of checks) {
    if (c.required || c.skipped) continue;
    subscores[c.id] = c.score ?? (c.pass ? 1 : 0);
  }

  return { verdict: requiredOk ? "pass" : "fail", subscores, checks };
}
