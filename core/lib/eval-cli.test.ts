import { describe, expect, spyOn, test } from "bun:test";

import { createEvalCliHandlers, type EvalCommandRunner } from "./eval-cli";
import { createProductionEvalCliHandlers } from "../agent-loop";

function createRunner(exitCodes: { run: number; report: number; selfcheck: number }): {
  runner: EvalCommandRunner;
  calls: string[];
} {
  const calls: string[] = [];

  return {
    runner: {
      async run() {
        calls.push("run");
        return exitCodes.run;
      },
      async report() {
        calls.push("report");
        return exitCodes.report;
      },
      async selfcheck() {
        calls.push("selfcheck");
        return exitCodes.selfcheck;
      },
    },
    calls,
  };
}

describe("eval CLI handlers", () => {
  test("routes run, report, and selfcheck exactly once while preserving numeric exit codes", async () => {
    const { runner, calls } = createRunner({ run: 0, report: 17, selfcheck: 1 });
    const handlers = createEvalCliHandlers(runner);

    expect(calls).toEqual([]);
    expect(await handlers.run()).toBe(0);
    expect(await handlers.report()).toBe(17);
    expect(await handlers.selfcheck()).toBe(1);
    expect(calls).toEqual(["run", "report", "selfcheck"]);
  });

  test("constructs production handlers without spawning an evaluation", () => {
    const spawn = spyOn(Bun, "spawn");

    try {
      const handlers = createProductionEvalCliHandlers();

      expect(handlers).toEqual({
        run: expect.any(Function),
        report: expect.any(Function),
        selfcheck: expect.any(Function),
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});
