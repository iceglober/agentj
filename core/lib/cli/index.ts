import { stderr as processStderr, stdout as processStdout } from "node:process";

import { command, flag, oneOf, option, optional, positional, runSafely, string } from "cmd-ts";

import type { ConfigCliHandlers } from "../config-cli";
import type { EvalCliHandlers } from "../eval-cli";
import type { UpdateChannel } from "../update";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ABORTED = 130;

export const DEFAULT_COMMAND_NAME = "glorious";
export const DEFAULT_COMMAND_DESCRIPTION =
  "Interactive coding agent. Bare invocation opens a chat session; `run` executes one task.";

export interface RunOnceOptions {
  /** Plan-only: read-only tools, no edits. */
  plan: boolean;
  /** Resolve permission asks to allow instead of the safe deny default. */
  allowAll: boolean;
  signal: AbortSignal;
}

export interface GloriousCommandDependencies {
  version: string;
  /** Update the installed Glorious CLI. */
  update?: (options: { channel: UpdateChannel }) => Promise<number>;
  /** The interactive chat session (default command). */
  runChat(options?: { resume?: string; continueLatest?: boolean }): Promise<number>;
  /** Non-interactive one-shot turn for scripts/CI. */
  runOnce(task: string, options: RunOnceOptions): Promise<number>;
  createAbortSignal?: () => AbortSignal;
  name?: string;
  description?: string;
  configHandlers?: ConfigCliHandlers;
  /** Interactive `glorious config` (no subcommand). Omitted → bare config errors. */
  runConfigUi?: () => Promise<number>;
  evalHandlers?: EvalCliHandlers;
  createEvalHandlers?: () => EvalCliHandlers | Promise<EvalCliHandlers>;
  writers?: GloriousCliIo;
}

export interface GloriousCliIo {
  stdout?: Pick<typeof processStdout, "write">;
  stderr?: Pick<typeof processStderr, "write">;
}

const createChatCommand = (deps: GloriousCommandDependencies) =>
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

const createUpdateCommand = (deps: GloriousCommandDependencies) =>
  command({
    name: `${deps.name ?? DEFAULT_COMMAND_NAME} update`,
    version: deps.version,
    description: "Update the Glorious CLI.",
    args: {
      channel: option({
        long: "channel",
        type: optional(oneOf(["next", "latest"] as const)),
        description: "Release channel to install.",
      }),
    },
    handler: ({ channel }) => deps.update!({ channel: channel ?? "auto" }),
  });

const createRunCommand = (deps: GloriousCommandDependencies) =>
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
    name: "glorious config set",
    description: "Set an Glorious configuration value.",
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
    name: "glorious config delete",
    description: "Delete an Glorious configuration value.",
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
    name: "glorious config get",
    description: "Read an Glorious configuration value.",
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
    name: `glorious config ${operation}`,
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

/** One argument or flag of a CLI command, as shown in `--help`. */
export interface CliArgDoc {
  usage: string;
  description: string;
}

/** A user-facing CLI command's documentable shape. */
export interface CliCommandDoc {
  name: string;
  description: string;
  args: CliArgDoc[];
  flags: CliArgDoc[];
}

/** cmd-ts commands expose their help rows through `helpTopics()`, which isn't in
 *  the published types; this is the slice we read. */
interface HelpTopic {
  category: string;
  usage: string;
  description: string;
}
interface Introspectable {
  name: string;
  description?: string;
  helpTopics(): HelpTopic[];
}

const describeCommand = (command: Introspectable): CliCommandDoc => {
  const rows = command.helpTopics();
  const inCategories = (categories: string[]): CliArgDoc[] =>
    rows
      // The auto-added help flag is noise in a reference table.
      .filter((row) => categories.includes(row.category) && !row.usage.startsWith("--help"))
      .map((row) => ({ usage: row.usage, description: row.description }));
  return {
    name: command.name,
    description: command.description ?? "",
    // Positionals are "arguments"; `--x` flags and `--x <value>` options both read
    // as flags in a reference (their usage string already shows any value).
    args: inCategories(["arguments"]),
    flags: inCategories(["flags", "options"]),
  };
};

/**
 * The user-facing command line, extracted from the same `command()` definitions
 * the parser runs — so docs and `--help` can never disagree. Handlers are never
 * invoked here (help extraction only reads structure), so no-op deps are safe.
 */
export function describeCli(): CliCommandDoc[] {
  const deps = {
    version: "",
    runChat: async () => EXIT_SUCCESS,
    runOnce: async () => EXIT_SUCCESS,
  } as GloriousCommandDependencies;
  const handlers = {} as ConfigCliHandlers;
  return [
    createChatCommand(deps),
    createRunCommand(deps),
    createUpdateCommand(deps),
    createConfigSetCommand(handlers),
    createConfigGetCommand(handlers),
    createConfigDeleteCommand(handlers),
  ].map((command) => describeCommand(command as unknown as Introspectable));
}

const writeResult = (
  result: Awaited<ReturnType<typeof runSafely>>,
  writers: Required<GloriousCliIo>,
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

const dispatchUpdate = async (
  argv: string[],
  deps: GloriousCommandDependencies,
  writers: Required<GloriousCliIo>,
): Promise<number> => {
  if (deps.update === undefined) {
    writers.stderr.write("error: update command is not available.\n");
    return EXIT_FAILURE;
  }
  return dispatchLeaf(createUpdateCommand(deps), argv, writers);
};

const evalHelp = (name: string, version: string): string =>
  `${name} eval ${version}\n` +
  "> Run Glorious evaluation commands.\n\n" +
  "ARGUMENTS:\n" +
  "  [str] - Optional command: report or selfcheck. [optional]\n\n" +
  "FLAGS:\n" +
  "  --help, -h    - show help [optional]\n" +
  "  --version, -v - print the version [optional]";

const dispatchConfig = async (
  argv: string[],
  handlers: ConfigCliHandlers | undefined,
  writers: Required<GloriousCliIo>,
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
  deps: GloriousCommandDependencies,
  writers: Required<GloriousCliIo>,
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
    writers.stderr.write("error: unknown eval command. Try 'glorious eval --help'.\n");
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
  writers: Required<GloriousCliIo>,
): Promise<number> => {
  const result = await runSafely(parser, argv);
  if (result._tag === "error") return writeResult(result, writers) ?? EXIT_FAILURE;
  return await Promise.resolve(result.value as number);
};

export async function runGloriousCli(
  argv: string[],
  deps: GloriousCommandDependencies,
  io: GloriousCliIo = {},
): Promise<number> {
  const writers: Required<GloriousCliIo> = {
    stdout: io.stdout ?? deps.writers?.stdout ?? processStdout,
    stderr: io.stderr ?? deps.writers?.stderr ?? processStderr,
  };

  if (argv[0] === "config" && argv.length === 1 && deps.runConfigUi) {
    return deps.runConfigUi();
  }

  if (isConfigRoute(argv)) {
    return dispatchConfig(argv, deps.configHandlers, writers);
  }

  if (isEvalRoute(argv)) {
    return dispatchEval(argv, deps, writers);
  }

  if (argv[0] === "run") {
    return dispatchLeaf(createRunCommand(deps), argv.slice(1), writers);
  }

  if (argv[0] === "update") {
    return dispatchUpdate(argv.slice(1), deps, writers);
  }

  return dispatchLeaf(createChatCommand(deps), argv, writers);
}
