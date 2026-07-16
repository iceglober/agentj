import { stderr as processStderr, stdout as processStdout } from "node:process";

import { command, flag, option, optional, positional, runSafely, string } from "cmd-ts";

import type { ConversationEvent, ConversationOutcome } from "../app/conversation";
import type { ConfigCliHandlers } from "../config-cli";
import type { EvalCliHandlers } from "../eval-cli";
import type { PromptUi, TranscriptRenderer } from "../tui";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ABORTED = 130;

export const DEFAULT_COMMAND_NAME = "agentj";
export const DEFAULT_COMMAND_DESCRIPTION = "Run one AgentJ task from the terminal.";

export interface AgentjTaskRunnerOptions {
  signal: AbortSignal;
  nextUserMessage?: () => Promise<string | null>;
  onEvent?: (event: ConversationEvent) => void | Promise<void>;
}

export type AgentjTaskRunner = (
  task: string,
  options: AgentjTaskRunnerOptions,
) => Promise<ConversationOutcome>;

export interface AgentjCommandDependencies {
  version: string;
  promptUi: PromptUi;
  createRenderer(task: string): TranscriptRenderer;
  runTask: AgentjTaskRunner;
  runSandboxTask?: (
    task: string,
    options: AgentjTaskRunnerOptions & { provider?: string },
  ) => Promise<ConversationOutcome>;
  resumeSession?: (id: string, options: AgentjTaskRunnerOptions) => Promise<ConversationOutcome>;
  createAbortSignal?: () => AbortSignal;
  name?: string;
  description?: string;
  configHandlers?: ConfigCliHandlers;
  evalHandlers?: EvalCliHandlers;
  createEvalHandlers?: () => EvalCliHandlers | Promise<EvalCliHandlers>;
  writers?: AgentjCliIo;
}

export interface AgentjCliIo {
  stdout?: Pick<typeof processStdout, "write">;
  stderr?: Pick<typeof processStderr, "write">;
}

const normalizeTask = (value: string | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toExitCode = (outcome: ConversationOutcome): number => {
  switch (outcome.kind) {
    case "success": {
      return EXIT_SUCCESS;
    }

    case "plan-ready": {
      return EXIT_SUCCESS;
    }

    case "aborted": {
      return EXIT_ABORTED;
    }

    case "generation-error":
    case "commit-error":
    case "build-blocked": {
      return EXIT_FAILURE;
    }
  }
};

const executeTask = async (
  task: string | undefined,
  deps: AgentjCommandDependencies,
  runner: AgentjTaskRunner,
): Promise<number> => {
  const resolvedTask = normalizeTask(task) ?? (await deps.promptUi.askTask());
  const normalizedTask = normalizeTask(resolvedTask ?? undefined);
  if (normalizedTask === null) return EXIT_SUCCESS;

  const renderer = deps.createRenderer(normalizedTask);
  renderer.renderPrompt();
  const outcome = await runner(normalizedTask, {
    signal: (deps.createAbortSignal ?? (() => new AbortController().signal))(),
    nextUserMessage: deps.promptUi.askFollowUp
      ? () => deps.promptUi.askFollowUp!()
      : async () => null,
    onEvent: (event) => renderer.renderEvent(event),
  });
  renderer.renderOutcome(outcome);
  return toExitCode(outcome);
};

export const createAgentjCommand = ({
  version,
  promptUi,
  createRenderer,
  runTask,
  createAbortSignal = () => new AbortController().signal,
  name = DEFAULT_COMMAND_NAME,
  description = DEFAULT_COMMAND_DESCRIPTION,
}: AgentjCommandDependencies) =>
  command({
    name,
    version,
    description,
    args: {
      task: positional({
        type: optional(string),
        description: "Task to run. If omitted, AgentJ asks once.",
      }),
    },
    handler: ({ task }) =>
      executeTask(
        task,
        {
          version,
          promptUi,
          createRenderer,
          runTask,
          createAbortSignal,
          name,
          description,
        },
        runTask,
      ),
  });

const createSandboxCommand = (deps: AgentjCommandDependencies, withProvider: boolean) =>
  command({
    name: `${deps.name ?? DEFAULT_COMMAND_NAME} sandbox`,
    version: deps.version,
    description: "Run one AgentJ task in an isolated sandbox.",
    args: {
      ...(withProvider
        ? { provider: option({ long: "provider", type: string, description: "Sandbox provider." }) }
        : {}),
      task: positional({
        type: optional(string),
        description: "Task to run. If omitted, AgentJ asks once.",
      }),
    },
    async handler(args): Promise<number> {
      if (!deps.runSandboxTask) return EXIT_FAILURE;
      const provider = "provider" in args ? args.provider : undefined;
      return executeTask(args.task, deps, (task, options) =>
        deps.runSandboxTask!(task, { ...options, ...(provider ? { provider } : {}) }),
      );
    },
  });

const createResumeCommand = (deps: AgentjCommandDependencies) =>
  command({
    name: `${deps.name ?? DEFAULT_COMMAND_NAME} --resume`,
    version: deps.version,
    description: "Resume an AgentJ session.",
    args: { resume: option({ long: "resume", type: string, description: "Session ID." }) },
    async handler({ resume }): Promise<number> {
      if (!deps.resumeSession) return EXIT_FAILURE;
      const renderer = deps.createRenderer(`resume ${resume}`);
      const outcome = await deps.resumeSession(resume, {
        signal: (deps.createAbortSignal ?? (() => new AbortController().signal))(),
        nextUserMessage: deps.promptUi.askFollowUp
          ? () => deps.promptUi.askFollowUp!()
          : async () => null,
        onEvent: (event) => renderer.renderEvent(event),
      });
      renderer.renderOutcome(outcome);
      return toExitCode(outcome);
    },
  });

const createConfigSetCommand = (handlers: ConfigCliHandlers) =>
  command({
    name: "agentj config set",
    description: "Set an AgentJ configuration value.",
    args: {
      secret: flag({
        long: "secret",
        description: "Read the value from masked input and store it in the keychain.",
      }),
      key: positional({
        type: string,
        displayName: "key",
        description: "Public configuration key to set.",
      }),
      value: positional({
        type: optional(string),
        displayName: "value",
        description: "Value to store for a normal configuration key.",
      }),
    },
    handler: ({ key, secret, value }) => handlers.set({ key, secret, value }),
  });

const createConfigDeleteCommand = (handlers: ConfigCliHandlers) =>
  command({
    name: "agentj config delete",
    description: "Delete an AgentJ configuration value.",
    args: {
      secret: flag({
        long: "secret",
        description: "Delete a secret stored in the keychain.",
      }),
      key: positional({
        type: string,
        displayName: "key",
        description: "Public configuration key to delete.",
      }),
    },
    handler: ({ key, secret }) => handlers.delete({ key, secret }),
  });

const createConfigGetCommand = (handlers: ConfigCliHandlers) =>
  command({
    name: "agentj config get",
    description: "Read an AgentJ configuration value.",
    args: {
      key: positional({
        type: string,
        displayName: "key",
        description: "Configuration key to read.",
      }),
    },
    handler: ({ key }) => handlers.get({ key }),
  });

const createConfigListMutationCommand = (
  handlers: ConfigCliHandlers,
  operation: "add" | "remove",
) =>
  command({
    name: `agentj config ${operation}`,
    description: `${operation === "add" ? "Append to" : "Remove from"} an array configuration value.`,
    args: {
      key: positional({
        type: string,
        displayName: "key",
        description: "Array configuration key.",
      }),
      value: positional({
        type: string,
        displayName: "value",
        description: "Array value to mutate.",
      }),
    },
    handler: ({ key, value }) => handlers[operation]({ key, value }),
  });

const writeResult = (
  result: Awaited<ReturnType<typeof runSafely>>,
  writers: Required<AgentjCliIo>,
): number | undefined => {
  if (result._tag !== "error") {
    return undefined;
  }

  const { exitCode, into, message } = result.error.config;
  (into === "stdout" ? writers.stdout : writers.stderr).write(message);
  return exitCode;
};

const isConfigRoute = (argv: string[]): boolean =>
  (argv[0] === "config" && argv[1] === "set") ||
  (argv[0] === "config" && ["get", "add", "remove", "delete"].includes(argv[1] ?? ""));

const isEvalRoute = (argv: string[]): boolean => argv[0] === "eval";

const evalHelp = (name: string, version: string): string =>
  `${name} eval ${version}\n` +
  "> Run AgentJ evaluation commands.\n\n" +
  "ARGUMENTS:\n" +
  "  [str] - Optional command: report or selfcheck. [optional]\n\n" +
  "FLAGS:\n" +
  "  --help, -h    - show help [optional]\n" +
  "  --version, -v - print the version [optional]";

const dispatchConfig = async (
  argv: string[],
  handlers: ConfigCliHandlers | undefined,
  writers: Required<AgentjCliIo>,
): Promise<number> => {
  if (handlers === undefined) {
    writers.stderr.write("error: config commands are not available.\n");
    return EXIT_FAILURE;
  }

  const commandForRoute =
    argv[1] === "set"
      ? createConfigSetCommand(handlers)
      : argv[1] === "delete"
        ? createConfigDeleteCommand(handlers)
        : argv[1] === "get"
          ? createConfigGetCommand(handlers)
          : createConfigListMutationCommand(handlers, argv[1] as "add" | "remove");
  const result = await runSafely(commandForRoute, argv.slice(2));
  if (result._tag === "error") {
    return writeResult(result, writers) ?? EXIT_FAILURE;
  }

  return (await result.value).ok ? EXIT_SUCCESS : EXIT_FAILURE;
};

const dispatchEval = async (
  argv: string[],
  deps: AgentjCommandDependencies,
  writers: Required<AgentjCliIo>,
): Promise<number> => {
  const args = argv.slice(1);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writers.stdout.write(evalHelp(deps.name ?? DEFAULT_COMMAND_NAME, deps.version));
    return EXIT_SUCCESS;
  }

  const route =
    args.length === 0
      ? "run"
      : args.length === 1 && (args[0] === "report" || args[0] === "selfcheck")
        ? args[0]
        : undefined;
  if (route === undefined) {
    writers.stderr.write("error: unknown eval command. Try 'agentj eval --help'.\n");
    return 2;
  }

  const handlers = deps.evalHandlers ?? (await deps.createEvalHandlers?.());
  if (handlers === undefined) {
    writers.stderr.write("error: eval commands are not available.\n");
    return EXIT_FAILURE;
  }

  return handlers[route]();
};

const dispatchLeaf = async (
  parser: Parameters<typeof runSafely>[0],
  argv: string[],
  writers: Required<AgentjCliIo>,
): Promise<number> => {
  const result = await runSafely(parser, argv);
  if (result._tag === "error") return writeResult(result, writers) ?? EXIT_FAILURE;
  return await Promise.resolve(result.value as number);
};

export async function runAgentjCli(
  argv: string[],
  deps: AgentjCommandDependencies,
  io: AgentjCliIo = {},
): Promise<number> {
  const writers: Required<AgentjCliIo> = {
    stdout: io.stdout ?? deps.writers?.stdout ?? processStdout,
    stderr: io.stderr ?? deps.writers?.stderr ?? processStderr,
  };

  if (isConfigRoute(argv)) {
    return dispatchConfig(argv, deps.configHandlers, writers);
  }

  if (isEvalRoute(argv)) {
    return dispatchEval(argv, deps, writers);
  }

  if (argv[0] === "--resume" || argv[0]?.startsWith("--resume=") === true) {
    return dispatchLeaf(createResumeCommand(deps), argv, writers);
  }

  if (argv[0] === "sandbox") {
    const args = argv.slice(1);
    const withProvider = args.some((arg) => arg === "--provider" || arg.startsWith("--provider="));
    return dispatchLeaf(createSandboxCommand(deps, withProvider), args, writers);
  }

  const result = await runSafely(createAgentjCommand(deps), argv);
  if (result._tag === "error") {
    return writeResult(result, writers) ?? EXIT_FAILURE;
  }

  return await Promise.resolve(result.value);
}
