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
  status(): Promise<string>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<string | null>;
  log(maxCount?: number): Promise<string>;
  /** Remove the worktree; the branch and its commits stay in the repo. */
  dispose(): Promise<void>;
}

const randomId = () => crypto.randomUUID().slice(0, 8);

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
  await scm.ensureRepo(sb, config.repoDir);
  await scm.addWorktree(sb, config.repoDir, path, branch);

  const dispose = () => scm.removeWorktree(sb, config.repoDir, path);
  return {
    id,
    path,
    branch,
    status: () => scm.status(sb, path),
    diff: () => scm.diff(sb, path),
    commitAll: (message) => scm.commitAll(sb, path, message),
    log: (maxCount) => scm.log(sb, path, maxCount),
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
