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
