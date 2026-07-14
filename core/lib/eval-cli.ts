export type EvalExitCode = number;

export interface EvalCommandRunner {
  run(): Promise<EvalExitCode>;
  report(): Promise<EvalExitCode>;
  selfcheck(): Promise<EvalExitCode>;
}

export interface EvalCliHandlers {
  run(): Promise<EvalExitCode>;
  report(): Promise<EvalExitCode>;
  selfcheck(): Promise<EvalExitCode>;
}

export function createEvalCliHandlers(runner: EvalCommandRunner): EvalCliHandlers {
  return {
    run: () => runner.run(),
    report: () => runner.report(),
    selfcheck: () => runner.selfcheck(),
  };
}

export function createProductionEvalCommandRunner(): EvalCommandRunner {
  const spawn = async (script: string, args: string[] = []): Promise<EvalExitCode> => {
    const child = Bun.spawn({
      cmd: [process.execPath, script, ...args],
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  };

  return {
    run: () => spawn("core/eval/run.ts"),
    report: () => spawn("core/eval/report.ts"),
    selfcheck: () => spawn("core/eval/run.ts", ["--selfcheck"]),
  };
}

export function createProductionEvalCliHandlers(): EvalCliHandlers {
  return createEvalCliHandlers(createProductionEvalCommandRunner());
}
