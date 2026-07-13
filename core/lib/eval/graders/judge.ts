import type { CheckGrader } from "../types";

export const gradeJudge: CheckGrader = async (_env, _task, traj, check, ctx) => {
  if (check.kind !== "judge") throw new Error("wrong grader");
  const result = await ctx.judge(check.rubric, traj.finalDiff, traj.finalText);
  if (result === null) return { pass: false, skipped: true, detail: "judge unavailable" };
  return { pass: result.pass, score: result.pass ? 1 : 0, detail: result.reason };
};
