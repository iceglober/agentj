import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolution of a launch directory to its canonical Git worktree root and
 * common Git directory. Both the host-first chat loop and the sandbox mount
 * preflight depend on this; it lives here so it cannot die with either.
 */
export type ProjectSource = {
  readonly projectRoot: string;
  readonly commonGitDir: string;
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
 * Resolve a launch directory to the Git worktree and common Git directory it
 * needs. Runs before any environment is built so unverified host paths never
 * reach a builder.
 */
export const resolveProjectSource = async (projectDir: string): Promise<ProjectSource> => {
  if (!isAbsolute(projectDir)) {
    throw new Error("projectDir must be an absolute directory path.");
  }

  let canonicalDir: string;
  try {
    canonicalDir = await realpath(projectDir);
    if (!(await stat(canonicalDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("projectDir is not a directory.");
  }

  try {
    const projectRoot = await realpath(await gitOutput(canonicalDir, ["--show-toplevel"]));
    const commonGitOutput = await gitOutput(projectRoot, ["--git-common-dir"]);
    const commonGitDir = await realpath(
      isAbsolute(commonGitOutput) ? commonGitOutput : resolve(projectRoot, commonGitOutput),
    );
    if (!(await stat(commonGitDir)).isDirectory()) throw new Error("not a directory");
    return { projectRoot, commonGitDir };
  } catch {
    throw new Error("projectDir is not inside a Git worktree.");
  }
};

/** Compatibility seam for callers that need only the canonical worktree root. */
export const resolveProjectDir = async (projectDir: string): Promise<string> =>
  (await resolveProjectSource(projectDir)).projectRoot;
