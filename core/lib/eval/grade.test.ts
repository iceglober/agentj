import { describe, expect, test } from "bun:test";
import type { SandboxCommandResult } from "../sandbox";
import { composeGrade } from "./grade";
import type { Check, Env, GradeCtx, Task, Trajectory } from "./types";
import { taskSchema } from "./types";

// --- fakes ---------------------------------------------------------------

interface FakeEnvOpts {
  exec?: (command: string) => SandboxCommandResult;
  changedFiles?: string[];
  diff?: string;
}

class FakeEnv implements Env {
  readonly id = "fake";
  readonly dir = "/fake";
  /** Every file written, in order. */
  readonly writes: { path: string; content: string }[] = [];
  /** Files present (by path) at the moment exec() was called. */
  filesAtExec: Record<string, string> = {};
  execCalled = false;
  private opts: FakeEnvOpts;

  constructor(opts: FakeEnvOpts = {}) {
    this.opts = opts;
  }

  async exec(command: string): Promise<SandboxCommandResult> {
    this.execCalled = true;
    this.filesAtExec = Object.fromEntries(this.writes.map((w) => [w.path, w.content]));
    return this.opts.exec?.(command) ?? { stdout: "", stderr: "", exitCode: 0 };
  }
  async writeFiles(files: { path: string; content: string }[]): Promise<void> {
    this.writes.push(...files);
  }
  async diff(): Promise<string> {
    return this.opts.diff ?? "";
  }
  async changedFiles(): Promise<string[]> {
    return this.opts.changedFiles ?? [];
  }
  async destroy(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

const noJudge: GradeCtx = { judge: async () => null };

function makeTask(checks: unknown[], fixtureFiles: Record<string, string> = {}): Task {
  return taskSchema.parse({
    id: "t1",
    prompt: "do the thing",
    fixture: { kind: "inline", files: fixtureFiles },
    checks,
  });
}

function makeTraj(over: Partial<Trajectory> = {}): Trajectory {
  return {
    toolCalls: [],
    toolResults: [],
    finalText: "",
    finalDiff: "",
    filesTouched: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    steps: 0,
    wallMs: 0,
    ...over,
  };
}

// --- composeGrade verdicts ----------------------------------------------

describe("composeGrade verdicts", () => {
  test("all required checks pass → pass", async () => {
    const task = makeTask([
      { kind: "test_command", id: "tc", command: "run", expectExit: 0 },
      { kind: "diff_scope", id: "ds", allow: ["**"] },
    ]);
    const env = new FakeEnv({ exec: () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("pass");
  });

  test("one required check fails → fail", async () => {
    const task = makeTask([{ kind: "test_command", id: "tc", command: "run", expectExit: 0 }]);
    const env = new FakeEnv({ exec: () => ({ stdout: "boom", stderr: "", exitCode: 1 }) });
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("fail");
    expect(res.checks[0]?.pass).toBe(false);
  });

  test("traj.error → error with no checks run", async () => {
    const task = makeTask([{ kind: "test_command", id: "tc", command: "run" }]);
    const env = new FakeEnv();
    const res = await composeGrade(env, task, makeTraj({ error: "adapter blew up" }), noJudge);
    expect(res.verdict).toBe("error");
    expect(res.checks).toHaveLength(0);
    expect(env.execCalled).toBe(false);
  });

  test("traj.timedOut → timeout", async () => {
    const task = makeTask([{ kind: "test_command", id: "tc", command: "run" }]);
    const env = new FakeEnv();
    const res = await composeGrade(env, task, makeTraj({ timedOut: true }), noJudge);
    expect(res.verdict).toBe("timeout");
    expect(res.checks).toHaveLength(0);
  });
});

// --- test_command resetPaths --------------------------------------------

describe("test_command resetPaths", () => {
  test("rewrites fixture content before exec", async () => {
    const task = makeTask(
      [
        {
          kind: "test_command",
          id: "tc",
          command: "python3 tests.py",
          resetPaths: ["tests.py"],
        },
      ],
      { "tests.py": "ORIGINAL FIXTURE" },
    );
    const env = new FakeEnv({ exec: () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("pass");
    // fixture file was present with its frozen content at exec time
    expect(env.filesAtExec["tests.py"]).toBe("ORIGINAL FIXTURE");
    expect(env.writes.some((w) => w.path === "tests.py" && w.content === "ORIGINAL FIXTURE")).toBe(
      true,
    );
  });

  test("resetPaths against a dir fixture → grader error → verdict error", async () => {
    const task = taskSchema.parse({
      id: "t1",
      prompt: "p",
      fixture: { kind: "dir", path: "/host/fixture" },
      checks: [{ kind: "test_command", id: "tc", command: "run", resetPaths: ["x.py"] }],
    });
    const env = new FakeEnv();
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("error");
    expect(res.checks[0]?.detail).toContain("inline fixture");
  });
});

// --- diff_scope ----------------------------------------------------------

describe("diff_scope", () => {
  test("violation detail names the out-of-scope file", async () => {
    const task = makeTask([{ kind: "diff_scope", id: "ds", allow: ["src/**"] }]);
    const env = new FakeEnv({ changedFiles: ["src/a.ts", "tests/b.ts"] });
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("fail");
    expect(res.checks[0]?.detail).toContain("tests/b.ts");
    expect(res.checks[0]?.detail).not.toContain("src/a.ts");
  });
});

// --- file_state ------------------------------------------------------------

describe("file_state", () => {
  const CONTENT = 'LABEL = "Billing Assistant"\nWARNING = "A sign-in code is still pending."\n';
  const catEnv = (content: string | null) =>
    new FakeEnv({
      exec: () =>
        content === null
          ? { stdout: "", stderr: "cat: no such file", exitCode: 1 }
          : { stdout: content, stderr: "", exitCode: 0 },
    });

  test("passes when required strings are present and forbidden ones absent", async () => {
    const task = makeTask([
      {
        kind: "file_state",
        id: "copy",
        path: "templates.py",
        contains: ["Billing Assistant"],
        absent: ["Organization Persona"],
      },
    ]);
    const res = await composeGrade(catEnv(CONTENT), task, makeTraj(), noJudge);
    expect(res.verdict).toBe("pass");
  });

  test("fails naming each missing and each still-present string", async () => {
    const task = makeTask([
      {
        kind: "file_state",
        id: "copy",
        path: "templates.py",
        contains: ["Approved Copy"],
        absent: ["sign-in code"],
      },
    ]);
    const res = await composeGrade(catEnv(CONTENT), task, makeTraj(), noJudge);
    expect(res.verdict).toBe("fail");
    expect(res.checks[0]?.detail).toContain('missing "Approved Copy"');
    expect(res.checks[0]?.detail).toContain('still contains "sign-in code"');
  });

  test("fails when the file cannot be read (e.g. deleted by the agent)", async () => {
    const task = makeTask([
      { kind: "file_state", id: "copy", path: "templates.py", contains: ["x"] },
    ]);
    const res = await composeGrade(catEnv(null), task, makeTraj(), noJudge);
    expect(res.verdict).toBe("fail");
    expect(res.checks[0]?.detail).toContain("cannot read");
  });
});

// --- report_contains -------------------------------------------------------

describe("report_contains", () => {
  test("matches case-insensitively against the final report", async () => {
    const task = makeTask([{ kind: "report_contains", id: "rc", contains: ["flags.py", "Audit"] }]);
    const traj = makeTraj({ finalText: "The default lives in FLAGS.PY; add an audit event." });
    const res = await composeGrade(new FakeEnv(), task, traj, noJudge);
    expect(res.verdict).toBe("pass");
  });

  test("fails an empty report, naming the missing points", async () => {
    const task = makeTask([{ kind: "report_contains", id: "rc", contains: ["legacy_flags"] }]);
    const res = await composeGrade(new FakeEnv(), task, makeTraj(), noJudge);
    expect(res.verdict).toBe("fail");
    expect(res.checks[0]?.detail).toContain('"legacy_flags"');
  });
});

// --- no_placeholder ------------------------------------------------------

describe("no_placeholder", () => {
  test("catches an added TODO, ignores removed and context lines", async () => {
    const diff = [
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1,3 +1,3 @@",
      "-# TODO removed, should be ignored",
      " # TODO in context, should be ignored",
      "+    real_code = 1",
      "+    x = 2  # TODO finish this",
    ].join("\n");
    const task = makeTask([{ kind: "no_placeholder", id: "np" }]);
    const env = new FakeEnv();
    // no_placeholder is non-required by default → subscore, not verdict.
    const res = await composeGrade(env, task, makeTraj({ finalDiff: diff }), noJudge);
    expect(res.checks[0]?.pass).toBe(false);
    expect(res.checks[0]?.detail).toContain("TODO");
    expect(res.subscores.np).toBe(0);
  });

  test("passes when no added line has a placeholder", async () => {
    const diff = ["--- a/x.py", "+++ b/x.py", "@@ -1 +1 @@", "-# TODO removed", "+x = 1"].join(
      "\n",
    );
    const task = makeTask([{ kind: "no_placeholder", id: "np" }]);
    const env = new FakeEnv();
    const res = await composeGrade(env, task, makeTraj({ finalDiff: diff }), noJudge);
    expect(res.checks[0]?.pass).toBe(true);
    expect(res.subscores.np).toBe(1);
  });
});

// --- diff_size -----------------------------------------------------------

describe("diff_size", () => {
  test("counts added and removed content lines, excludes headers", async () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old",
      "+new1",
      "+new2",
    ].join("\n");
    // 3 change lines (1 del + 2 add); headers/context excluded.
    const task = makeTask([{ kind: "diff_size", id: "sz", maxChangedLines: 2 }]);
    const env = new FakeEnv();
    const res = await composeGrade(env, task, makeTraj({ finalDiff: diff }), noJudge);
    expect(res.checks[0]?.pass).toBe(false);
    expect(res.checks[0]?.detail).toContain("3 changed");

    const okTask = makeTask([{ kind: "diff_size", id: "sz", maxChangedLines: 3 }]);
    const okRes = await composeGrade(env, okTask, makeTraj({ finalDiff: diff }), noJudge);
    expect(okRes.checks[0]?.pass).toBe(true);
  });
});

// --- judge ---------------------------------------------------------------

describe("judge", () => {
  test("null (unavailable) → skipped, excluded from verdict and subscores", async () => {
    const task = makeTask([
      // required judge that is skipped must NOT force a fail
      { kind: "judge", id: "j", rubric: "is it good", required: true },
    ]);
    const env = new FakeEnv();
    const ctx: GradeCtx = { judge: async () => null };
    const res = await composeGrade(env, task, makeTraj(), ctx);
    expect(res.checks[0]?.skipped).toBe(true);
    expect(res.verdict).toBe("pass"); // skipped required check ignored
    expect(res.subscores).not.toHaveProperty("j");
  });

  test("judge pass → subscore 1", async () => {
    const task = makeTask([{ kind: "judge", id: "j", rubric: "is it good" }]);
    const env = new FakeEnv();
    const ctx: GradeCtx = { judge: async () => ({ pass: true, reason: "looks right" }) };
    const res = await composeGrade(env, task, makeTraj(), ctx);
    expect(res.checks[0]?.pass).toBe(true);
    expect(res.subscores.j).toBe(1);
  });
});

// --- grader throw → error ------------------------------------------------

describe("harness error", () => {
  test("a grader that throws → verdict error, not fail", async () => {
    const task = makeTask([{ kind: "test_command", id: "tc", command: "run" }]);
    const env = new FakeEnv({
      exec: () => {
        throw new Error("sandbox exploded");
      },
    });
    const res = await composeGrade(env, task, makeTraj(), noJudge);
    expect(res.verdict).toBe("error");
    expect(res.checks[0]?.detail).toContain("sandbox exploded");
  });
});

// --- taskSchema ----------------------------------------------------------

describe("taskSchema", () => {
  test("rejects empty checks array", () => {
    expect(() =>
      taskSchema.parse({
        id: "t",
        prompt: "p",
        fixture: { kind: "inline", files: {} },
        checks: [],
      }),
    ).toThrow();
  });

  test("fills defaults (version 1, budget.steps 40, tags [])", () => {
    const task = makeTask([{ kind: "test_command", id: "tc", command: "run" }]);
    expect(task.version).toBe(1);
    expect(task.budget.steps).toBe(40);
    expect(task.tags).toEqual([]);
    expect(task.timeoutSec).toBe(600);
    // check-level defaults too
    const check = task.checks[0] as Extract<Check, { kind: "test_command" }>;
    expect(check.required).toBe(true);
    expect(check.expectExit).toBe(0);
    expect(check.resetPaths).toEqual([]);
  });
});
