export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Command and file execution boundary, independent of where it is hosted. */
export interface ExecutionEnvironment {
  /** `signal` requests cancellation of the running command: implementations
   *  that can kill the underlying process resolve promptly with a nonzero
   *  result; others may ignore it (the command then runs to completion). */
  executeCommand(command: string, options?: { signal?: AbortSignal }): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void>;
}

export type ExecutionEnvironmentProvider<T extends ExecutionEnvironment = ExecutionEnvironment> =
  () => Promise<T> | T;

export async function getExecutionEnvironment<T extends ExecutionEnvironment>(
  provider: ExecutionEnvironmentProvider<T>,
): Promise<T> {
  return await provider();
}

import z from "zod";

export const projectSetupConfigSchema = z.object({
  setup: z.array(z.string().min(1)).default([]),
});
