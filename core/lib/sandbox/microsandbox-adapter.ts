import { isAbsolute, relative } from "node:path";
import { Sandbox as Microsandbox } from "microsandbox";
import z from "zod";
import type { Sandbox, SandboxCommandResult } from "./index";

/** The `sandbox.*` section of the agent config. */
export const microsandboxOptionsSchema = z.object({
  name: z.string().default("worker"),
  /** Generic Glorious base image; users may override it with any OCI image. */
  image: z.string().default("ghcr.io/iceglober/glorious-sandbox-base:1"),
  /** Commands run once after the sandbox starts and before Glorious creates a session worktree. */
  bootstrap: z.array(z.string().min(1)).default([]),
  /** Created via rootfs patch before boot; commands run here. */
  workdir: z.string().default("/workspace"),
  /** Host directory containing the Git worktree to expose to the guest. */
  projectDir: z.string().optional(),
});

export type MicrosandboxProviderOptions = z.input<typeof microsandboxOptionsSchema> & {
  /** Preflighted host paths from the composition root; intentionally not config-schema input. */
  projectSource?: ProjectSource;
};

type MicrosandboxBuilder = ReturnType<typeof Microsandbox.builder>;
type MicrosandboxOptions = z.output<typeof microsandboxOptionsSchema>;

/** The verified host paths required to make a project and its Git metadata visible to a guest. */
export {
  type ProjectSource,
  resolveProjectDir,
  resolveProjectSource,
} from "../workspace/project-source";

import { type ProjectSource, resolveProjectSource } from "../workspace/project-source";

const isNestedPath = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
};

/** Validate only the injected source's mount-path shape; app-run resolves it once. */
const validateProjectSource = (projectSource: ProjectSource): ProjectSource => {
  const { projectRoot, commonGitDir } = projectSource;
  if (
    projectRoot.length === 0 ||
    commonGitDir.length === 0 ||
    !isAbsolute(projectRoot) ||
    !isAbsolute(commonGitDir)
  ) {
    throw new Error("Microsandbox project source is invalid.");
  }

  return projectSource;
};

/** Configure the builder without creating a VM; exported for mount-configuration tests. */
export const configureMicrosandboxBuilder = (
  builder: MicrosandboxBuilder,
  options: MicrosandboxOptions,
  projectSource?: ProjectSource,
): MicrosandboxBuilder => {
  let configured = builder
    .image(options.image)
    .patch((p) => p.mkdir(options.workdir, { mode: 0o755 }))
    .workdir(options.workdir);

  if (projectSource) {
    configured = configured.volume(projectSource.projectRoot, (mount) =>
      mount.bind(projectSource.projectRoot),
    );
    if (!isNestedPath(projectSource.projectRoot, projectSource.commonGitDir)) {
      configured = configured.volume(projectSource.commonGitDir, (mount) =>
        mount.bind(projectSource.commonGitDir),
      );
    }
  }

  return configured.replace();
};

/** Run user-approved environment provisioning before any session or model work begins. */
export const runSandboxBootstrap = async (
  sandbox: Pick<Sandbox, "executeCommand">,
  commands: readonly string[],
): Promise<void> => {
  for (const [index, command] of commands.entries()) {
    const result = await sandbox.executeCommand(command);
    if (result.exitCode !== 0) {
      // Commands and output may contain secrets; report only safe execution metadata.
      throw new Error(
        `Sandbox bootstrap command ${index + 1} failed with exit code ${result.exitCode}.`,
      );
    }
  }
};

export const createSandboxProviderMicrosandbox =
  (options: MicrosandboxProviderOptions = {}) =>
  async (): Promise<Sandbox & AsyncDisposable> => {
    const { projectSource: injectedProjectSource, ...configOptions } = options;
    const parsedOptions = microsandboxOptionsSchema.parse(configOptions);
    const projectSource = injectedProjectSource
      ? await validateProjectSource(injectedProjectSource)
      : parsedOptions.projectDir
        ? await resolveProjectSource(parsedOptions.projectDir)
        : undefined;
    const sb = await configureMicrosandboxBuilder(
      Microsandbox.builder(parsedOptions.name),
      parsedOptions,
      projectSource,
    ).create();
    const executeCommand = async (command: string): Promise<SandboxCommandResult> => {
      const r = await sb.shell(command);
      return { stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code };
    };
    try {
      await runSandboxBootstrap({ executeCommand }, parsedOptions.bootstrap);
    } catch (error) {
      await sb[Symbol.asyncDispose]().catch(() => undefined);
      throw error;
    }
    return {
      executeCommand,
      async readFile(path) {
        return sb.fs().readToString(path);
      },
      async writeFiles(files) {
        for (const file of files) {
          const dir = file.path.split("/").slice(0, -1).join("/");
          if (dir) await sb.shell(`mkdir -p '${dir.replaceAll("'", "'\\''")}'`);
          await sb.fs().write(file.path, file.content);
        }
      },
      [Symbol.asyncDispose]: () => sb[Symbol.asyncDispose](),
    };
  };
