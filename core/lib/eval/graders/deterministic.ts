import { shq } from "../../shell";
import { globMatch } from "../glob";
import type { CheckGrader } from "../types";

/** Last `n` non-empty lines of a blob, truncated to `max` chars. */
function tail(text: string, n = 6, max = 500): string {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out = lines.slice(-n).join("\n");
  return out.length > max ? out.slice(-max) : out;
}

/** Inline fixture files for a task, keyed by path. Throws for dir fixtures. */
function fixtureFiles(fixture: unknown): Record<string, string> {
  const f = fixture as { kind: string; files?: Record<string, string> };
  if (f.kind !== "inline")
    throw new Error(
      "resetPaths requires an inline fixture (dir fixtures are read by the composition root)",
    );
  return f.files ?? {};
}

export const gradeTestCommand: CheckGrader = async (env, task, _traj, check) => {
  if (check.kind !== "test_command") throw new Error("wrong grader");

  if (check.resetPaths.length > 0) {
    // Re-write graded paths from the frozen fixture so editing them can't game
    // the grade. dir fixtures throw here → composeGrade turns it into "error".
    const files = fixtureFiles(task.fixture);
    const writes: { path: string; content: string }[] = [];
    for (const p of check.resetPaths) {
      const content = files[p];
      if (content === undefined) throw new Error(`resetPaths: "${p}" is not in the task fixture`);
      writes.push({ path: p, content });
    }
    await env.writeFiles(writes);
  }

  const res = await env.exec(check.command);
  const pass = res.exitCode === check.expectExit;
  const detail = pass
    ? `exit ${res.exitCode} as expected`
    : `exit ${res.exitCode} (wanted ${check.expectExit}): ${tail(`${res.stdout}\n${res.stderr}`)}`;
  return { pass, detail };
};

export const gradeFileState: CheckGrader = async (env, _task, _traj, check) => {
  if (check.kind !== "file_state") throw new Error("wrong grader");

  const res = await env.exec(`cat ${shq(check.path)}`);
  if (res.exitCode !== 0)
    return { pass: false, detail: `cannot read "${check.path}": ${tail(res.stderr, 1)}` };

  const missing = check.contains.filter((s) => !res.stdout.includes(s));
  const present = check.absent.filter((s) => res.stdout.includes(s));
  const pass = missing.length === 0 && present.length === 0;
  const problems = [
    ...missing.map((s) => `missing "${s}"`),
    ...present.map((s) => `still contains "${s}"`),
  ];
  return {
    pass,
    detail: pass
      ? `"${check.path}" matches expected state`
      : `"${check.path}": ${problems.join("; ")}`,
  };
};

export const gradeDiffScope: CheckGrader = async (env, _task, _traj, check) => {
  if (check.kind !== "diff_scope") throw new Error("wrong grader");
  const changed = await env.changedFiles();
  const violators = changed.filter((p) => !check.allow.some((g) => globMatch(g, p)));
  const pass = violators.length === 0;
  return {
    pass,
    detail: pass
      ? `all ${changed.length} changed path(s) in scope`
      : `out of scope: ${violators.join(", ")}`,
  };
};
