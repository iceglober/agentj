export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  teeFiles?: Array<{
    command: string;
    stdoutFile: string;
  }>;
}

export interface Sandbox {
  executeCommand(command: string): Promise<SandboxCommandResult>;
  readFile(path: string): Promise<string>;
  writeFiles(
    files: Array<{
      path: string;
      content: string | Buffer;
    }>,
  ): Promise<void>;
}

export class SandboxProvisioningError extends Error {
  constructor(error: unknown | Error) {
    super();
    if (error instanceof Error) {
      this.cause = error.cause;
      this.message = error.message;
      this.name = error.name;
      this.stack = error.stack;
    } else {
      this.message = "Unknown error";
    }
  }
}

export type SandboxProvider<T extends Sandbox = Sandbox> = () => Promise<T> | T;

export const getSandbox = async <T extends Sandbox>(
  sandboxProvider: SandboxProvider<T>,
): Promise<T> => {
  try {
    return await sandboxProvider();
  } catch (e) {
    throw new SandboxProvisioningError(e);
  }
};
