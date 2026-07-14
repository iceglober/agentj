import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Sandbox as Microsandbox } from "microsandbox";
import z from "zod";
import type { Sandbox } from "./index";

/** The `sandbox.*` section of the agent config. */
export const microsandboxOptionsSchema = z.object({
  name: z.string().default("worker"),
  /** OCI image reference, Docker-style (e.g. "python", "ubuntu:24.04"). */
  image: z.string().default("python"),
  /** Created via rootfs patch before boot; commands run here. */
  workdir: z.string().default("/workspace"),
  /** Host directory containing the Git worktree to expose to the guest. */
  projectDir: z.string().optional(),
});

export type MicrosandboxProviderOptions = z.input<
  typeof microsandboxOptionsSchema
>;

type MicrosandboxBuilder = ReturnType<typeof Microsandbox.builder>;
type MicrosandboxOptions = z.output<typeof microsandboxOptionsSchema>;

/** The verified host paths required to make a project and its Git metadata visible to a guest. */
export type ProjectSource = {
  projectRoot: string;
  commonGitDir: string;
};

const gitOutput = async (projectRoot: string, args: string[]): Promise<string> => {
  const process = Bun.spawn({
    cmd: ["git", "-C", projectRoot, "rev-parse", ...args],
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0 || !stdout.trim()) throw new Error("Git preflight failed.");
  return stdout.trim();
};

/**
 * Resolve a launch directory to the Git worktree and common Git directory it needs.
 * This must run before creating a sandbox so unverified host paths never reach its builder.
 */
export const resolveProjectSource = async (projectDir: string): Promise<ProjectSource> => {
  if (!isAbsolute(projectDir)) {
    throw new Error("Microsandbox projectDir must be an absolute directory path.");
  }

  let canonicalDir: string;
  try {
    canonicalDir = await realpath(projectDir);
    if (!(await stat(canonicalDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("Microsandbox projectDir is not a directory.");
  }

  try {
    const projectRoot = await realpath(
      await gitOutput(canonicalDir, ["--show-toplevel"]),
    );
    const commonGitOutput = await gitOutput(projectRoot, ["--git-common-dir"]);
    const commonGitDir = await realpath(
      isAbsolute(commonGitOutput)
        ? commonGitOutput
        : resolve(projectRoot, commonGitOutput),
    );
    if (!(await stat(commonGitDir)).isDirectory()) throw new Error("not a directory");
    return { projectRoot, commonGitDir };
  } catch {
    throw new Error("Microsandbox projectDir is not inside a Git worktree.");
  }
};

/** Compatibility seam for callers that need only the canonical worktree root. */
export const resolveProjectDir = async (projectDir: string): Promise<string> =>
  (await resolveProjectSource(projectDir)).projectRoot;

const isNestedPath = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
};

/** Configure the builder without creating a VM; exported for mount-configuration tests. */
export const configureMicrosandboxBuilder = (
  builder: MicrosandboxBuilder,
  options: MicrosandboxOptions,
  projectSource?: ProjectSource | string,
): MicrosandboxBuilder => {
  let configured = builder
    .image(options.image)
    .patch((p) => p.mkdir(options.workdir, { mode: 0o755 }))
    .workdir(options.workdir);

  if (typeof projectSource === "string") {
    throw new Error("Microsandbox project source must be resolved before mounting.");
  }

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

export const createSandboxProviderMicrosandbox = (
  options: MicrosandboxProviderOptions = {},
) =>
  async (): Promise<Sandbox & AsyncDisposable> => {
    const parsedOptions = microsandboxOptionsSchema.parse(options);
    const projectSource = parsedOptions.projectDir
      ? await resolveProjectSource(parsedOptions.projectDir)
      : undefined;
    const sb = await configureMicrosandboxBuilder(
      Microsandbox.builder(parsedOptions.name),
      parsedOptions,
      projectSource,
    ).create();
    return {
      async executeCommand(command) {
        const r = await sb.shell(command);
        return { stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code };
      },
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
