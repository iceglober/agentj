import { stderr as processStderr, stdout as processStdout } from "node:process";

import {
  createProductionTaskRunDependencies,
  runAgentTask,
} from "./lib/app/run";
import { runAgentjCli } from "./lib/cli";
import { createConfigCliHandlers } from "./lib/config-cli";
import { createProductionEvalCliHandlers } from "./lib/eval-cli";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createPromptsSecretPrompt } from "./secrets-cli";
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
  const configHandlers = createConfigCliHandlers({
    secretStore: createKeyringSecretStore({}),
    prompt: {
      async askSecret() {
        return createPromptsSecretPrompt().askAzureApiKey();
      },
    },
    writers,
  });
  let evalHandlers: ReturnType<typeof createProductionEvalCliHandlers> | undefined;
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
        configHandlers,
        createEvalHandlers: () => (evalHandlers ??= createProductionEvalCliHandlers()),
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
            createProductionTaskRunDependencies(undefined, {
              projectDir: process.cwd(),
            }));
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
