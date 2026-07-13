import { stderr as processStderr, stdout as processStdout } from "node:process";

import {
  createProductionTaskRunDependencies,
  runAgentTask,
} from "./lib/app/run";
import { runAgentjCli } from "./lib/cli";
import {
  createNodeTerminalWriters,
  createPromptsPromptUi,
  createTranscriptRenderer,
} from "./lib/tui";

const COMMAND_VERSION = "0.0.0";

const formatUnexpectedError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const abortController = new AbortController();
  const promptUi = createPromptsPromptUi({
    stdin: process.stdin,
    stdout: processStdout,
    isInteractive: Boolean(process.stdin.isTTY),
  });
  const writers = createNodeTerminalWriters(processStdout, processStderr);
  let productionDependencies:
    | ReturnType<typeof createProductionTaskRunDependencies>
    | undefined;

  const handleSigint = (): void => {
    abortController.abort();
  };

  process.once("SIGINT", handleSigint);

  try {
    const exitCode = await runAgentjCli(
      argv,
      {
        version: COMMAND_VERSION,
        promptUi,
        createAbortSignal: () => abortController.signal,
        createRenderer(task) {
          return createTranscriptRenderer({
            task,
            writers,
            color: "auto",
            isTty: Boolean(processStdout.isTTY),
          });
        },
        async runTask(task, options) {
          const dependencies = await (productionDependencies ??=
            createProductionTaskRunDependencies());
          return runAgentTask(task, {
            ...options,
            dependencies,
          });
        },
      },
      {
        stdout: processStdout,
        stderr: processStderr,
      },
    );

    process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    processStderr.write(`${formatUnexpectedError(error)}\n`);
    process.exitCode = 1;
  }
}
