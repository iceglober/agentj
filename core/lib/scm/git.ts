import type { Sandbox } from "../sandbox";
import { shq } from "../shell";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Run git in the sandbox; returns stdout, throws GitError on failure. */
export async function git(
  sb: Sandbox,
  cwd: string,
  args: string[],
): Promise<string> {
  const cmd = `git -C ${shq(cwd)} ${args.map(shq).join(" ")}`;
  const r = await sb.executeCommand(cmd);
  if (r.exitCode !== 0) throw new GitError(args, r.exitCode, r.stderr);
  return r.stdout;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Set the sandbox-global commit identity (idempotent). */
export async function ensureIdentity(sb: Sandbox, identity: GitIdentity) {
  await sb.executeCommand(
    `git config --global user.name ${shq(identity.name)} && ` +
      `git config --global user.email ${shq(identity.email)} && ` +
      `git config --global init.defaultBranch main`,
  );
}

export async function isRepo(sb: Sandbox, dir: string): Promise<boolean> {
  const r = await sb.executeCommand(
    `git -C ${shq(dir)} rev-parse --is-inside-work-tree 2>/dev/null`,
  );
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

/**
 * Make `dir` a git repository with at least one commit (worktrees need a
 * HEAD to branch from). Existing repos and files are left as-is; a dirty
 * new repo gets its contents committed as the initial commit.
 */
export async function ensureRepo(sb: Sandbox, dir: string) {
  await sb.executeCommand(`mkdir -p ${shq(dir)}`);
  if (!(await isRepo(sb, dir))) await git(sb, dir, ["init"]);
  const hasCommit =
    (await sb.executeCommand(`git -C ${shq(dir)} rev-parse -q --verify HEAD`))
      .exitCode === 0;
  if (!hasCommit) {
    await git(sb, dir, ["add", "-A"]);
    await git(sb, dir, ["commit", "--allow-empty", "-m", "initial commit"]);
  }
}

export async function addWorktree(
  sb: Sandbox,
  repoDir: string,
  path: string,
  branch: string,
) {
  await git(sb, repoDir, ["worktree", "add", "-b", branch, path]);
}

/** Remove a worktree; the branch (and its commits) survive in the repo. */
export async function removeWorktree(
  sb: Sandbox,
  repoDir: string,
  path: string,
) {
  await git(sb, repoDir, ["worktree", "remove", "--force", path]);
}

/** Porcelain status; empty string means clean. */
export async function status(sb: Sandbox, dir: string): Promise<string> {
  return (await git(sb, dir, ["status", "--porcelain"])).trimEnd();
}

/** Diff of the working tree against HEAD, untracked files included. */
export async function diff(sb: Sandbox, dir: string): Promise<string> {
  await git(sb, dir, ["add", "-N", "."]);
  return (await git(sb, dir, ["diff", "HEAD"])).trimEnd();
}

/** Stage everything and commit; returns the short hash, or null if clean. */
export async function commitAll(
  sb: Sandbox,
  dir: string,
  message: string,
): Promise<string | null> {
  if ((await status(sb, dir)) === "") return null;
  await git(sb, dir, ["add", "-A"]);
  await git(sb, dir, ["commit", "-m", message]);
  return (await git(sb, dir, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function log(
  sb: Sandbox,
  dir: string,
  maxCount = 20,
): Promise<string> {
  return (
    await git(sb, dir, ["log", "--oneline", `--max-count=${maxCount}`])
  ).trimEnd();
}
