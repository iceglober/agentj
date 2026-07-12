import z from "zod";
import * as scm from "../scm/git";
import type { Sandbox } from "../sandbox";

/** The `session.*` section of the agent config. */
export const sessionConfigSchema = z.object({
  /** Repository the session branches from; created if missing. */
  repoDir: z.string().default("/repo"),
  /** Session worktrees live under this directory. */
  root: z.string().default("/workspace"),
  branchPrefix: z.string().default("session/"),
  /**
   * Where the session branch starts:
   * - "auto": remote default branch (fetched, best-effort) when a remote
   *   exists, else local HEAD, else adopt the directory as a new repo.
   * - "remote-default": origin's default branch; error if unresolvable.
   * - "head": current local HEAD (adopting the directory if not a repo yet).
   * - anything else: an explicit ref, verified to exist.
   */
  base: z.string().default("auto"),
  identity: z
    .object({
      name: z.string().default("agentj"),
      email: z.string().default("agentj@sandbox.local"),
    })
    .prefault({}),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export interface Session extends AsyncDisposable {
  readonly id: string;
  /** The session's git worktree — point the agent's tools here. */
  readonly path: string;
  readonly branch: string;
  /** The resolved ref the session branched from, e.g. "origin/main". */
  readonly base: string;
  status(): Promise<string>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<string | null>;
  log(maxCount?: number): Promise<string>;
  /** Remove the worktree; the branch and its commits stay in the repo. */
  dispose(): Promise<void>;
}

const randomId = () => crypto.randomUUID().slice(0, 8);

/**
 * Resolve the ref a new session branches from, per `config.base`.
 * May initialize/adopt the repo when the policy allows starting from scratch.
 */
async function resolveBase(sb: Sandbox, config: SessionConfig): Promise<string> {
  const { repoDir, base } = config;
  const ready = (await scm.isRepo(sb, repoDir)) && (await scm.hasCommits(sb, repoDir));

  if (base === "head" || base === "auto") {
    if (!ready) {
      if (base === "auto" && (await scm.isRepo(sb, repoDir)) && (await scm.hasRemote(sb, repoDir))) {
        // cloned-but-unborn repo: prefer the remote over adopting
        const remoteRef = await resolveRemoteDefault(sb, repoDir, false);
        if (remoteRef) return remoteRef;
      }
      await scm.ensureRepo(sb, repoDir); // init/adopt working files
      return "HEAD";
    }
    if (base === "head") return "HEAD";
    if (await scm.hasRemote(sb, repoDir)) {
      const remoteRef = await resolveRemoteDefault(sb, repoDir, false);
      if (remoteRef) return remoteRef;
    }
    return "HEAD";
  }

  if (base === "remote-default") {
    if (!(await scm.isRepo(sb, repoDir)))
      throw new Error(`session.base "remote-default": ${repoDir} is not a git repository`);
    const remoteRef = await resolveRemoteDefault(sb, repoDir, true);
    if (!remoteRef)
      throw new Error(
        `session.base "remote-default": cannot resolve origin's default branch in ${repoDir}`,
      );
    return remoteRef;
  }

  // explicit ref
  if (!ready)
    throw new Error(`session.base "${base}": ${repoDir} has no commits to resolve it against`);
  if (!(await scm.refExists(sb, repoDir, base)))
    throw new Error(`session.base "${base}": ref does not exist in ${repoDir}`);
  return base;
}

/**
 * "origin/<default>" with a best-effort fetch first; a failed fetch falls
 * back to the last-known tracking ref. Null (or throw, when strict) if the
 * default branch can't be determined or has never been fetched.
 */
async function resolveRemoteDefault(
  sb: Sandbox,
  repoDir: string,
  strict: boolean,
): Promise<string | null> {
  const name = await scm.remoteDefaultBranch(sb, repoDir);
  if (!name) return null;
  const fetched = await scm.tryFetch(sb, repoDir, "origin", name);
  const ref = `origin/${name}`;
  if (await scm.refExists(sb, repoDir, ref)) return ref;
  if (strict)
    throw new Error(
      `session.base "remote-default": ${ref} unavailable${fetched ? "" : " (fetch failed)"}`,
    );
  return null;
}

/**
 * A session is a git worktree on its own branch: parallel sessions in one
 * sandbox stay isolated, and a session's work is a branch you can diff,
 * merge, or discard. Disposal removes the worktree but keeps the branch.
 */
export async function createSession(
  sb: Sandbox,
  config: SessionConfig,
  id: string = randomId(),
): Promise<Session> {
  const path = `${config.root}/${id}`;
  const branch = `${config.branchPrefix}${id}`;

  await scm.ensureIdentity(sb, config.identity);
  const base = await resolveBase(sb, config);
  await scm.addWorktree(sb, config.repoDir, path, branch, base);

  const dispose = () => scm.removeWorktree(sb, config.repoDir, path);
  return {
    id,
    path,
    branch,
    base,
    status: () => scm.status(sb, path),
    diff: () => scm.diff(sb, path),
    commitAll: (message) => scm.commitAll(sb, path, message),
    log: (maxCount) => scm.log(sb, path, maxCount),
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
