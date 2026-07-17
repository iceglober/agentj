import { stderr as processStderr, stdout as processStdout } from "node:process";

import { command, flag, option, optional, positional, runSafely, string } from "cmd-ts";

import type { ConfigCliHandlers } from "../config-cli";
import type { EvalCliHandlers } from "../eval-cli";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ABORTED = 130;

export const DEFAULT_COMMAND_NAME = "agentj";
export const DEFAULT_COMMAND_DESCRIPTION =
  "Interactive coding agent. Bare invocation opens a chat session; `run` executes one task.";

export interface RunOnceOptions {
  /** Plan-only: read-only tools, no edits. */
  plan: boolean;
  /** Resolve permission asks to allow instead of the safe deny default. */
  allowAll: boolean;
  signal: AbortSignal;
}

export interface AgentjCommandDependencies {
  version: string;
  /** The interactive chat session (default command). */
  runChat(options?: { resume?: string; continueLatest?: boolean }): Promise<number>;
  /** Non-interactive one-shot turn for scripts/CI. */
  runOnce(task: string, options: RunOnceOptions): Promise<number>;
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

const createChatCommand = (deps: AgentjCommandDependencies) =>
  command({
    name: deps.name ?? DEFAULT_COMMAND_NAME,
    version: deps.version,
    description: deps.description ?? DEFAULT_COMMAND_DESCRIPTION,
    args: {
      resume: option({
        long: "resume",
        type: optional(string),
        description: "Resume a chat session by id.",
      }),
      continueLatest: flag({
        long: "continue",
        description: "Resume the newest chat session for this project.",
      }),
    },
    handler: ({ resume, continueLatest }) =>
      deps.runChat({ ...(resume ? { resume } : {}), continueLatest }),
  });

const createRunCommand = (deps: AgentjCommandDependencies) =>
  command({
    name: `${deps.name ?? DEFAULT_COMMAND_NAME} run`,
    version: deps.version,
    description: "Run one task non-interactively and exit.",
    args: {
      plan: flag({ long: "plan", description: "Plan only — read-only tools, no edits." }),
      allowAll: flag({
        long: "allow-all",
        description: "Resolve permission asks to allow (default: deny with a notice).",
      }),
      task: positional({ type: string, displayName: "task", description: "Task to run." }),
    },
    handler: ({ task, plan, allowAll }) =>
      deps.runOnce(task.trim(), {
        plan,
        allowAll,
        signal: (deps.createAbortSignal ?? (() => new AbortController().signal))(),
      }),
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
  // cmd-ts messages (--help, --version) carry no trailing newline; writing
  // them verbatim leaves the shell prompt glued to the output.
  (into === "stdout" ? writers.stdout : writers.stderr).write(
    message.endsWith("\n") ? message : `${message}\n`,
  );
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

  if (argv[0] === "run") {
    return dispatchLeaf(createRunCommand(deps), argv.slice(1), writers);
  }

  return dispatchLeaf(createChatCommand(deps), argv, writers);
}
