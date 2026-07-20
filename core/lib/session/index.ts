import z from "zod";
import type { Sandbox } from "../sandbox";
import * as scm from "../scm/git";

/** The `session.*` section of the agent config. */
export const sessionConfigSchema = z.object({
  /** Repository the session branches from; created if missing. */
  repoDir: z.string().default("/repo"),
  /** Session worktrees live under this directory. */
  root: z.string().default("/workspace"),
  branchPrefix: z.string().default("session/"),
  /**
   * Where the session branch starts:
   * - "auto": newest descendant of local and remote default branches; when
   *   they diverge, prefer the shared remote baseline. Falls back to HEAD.
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
  readonly mode?: "local" | "sandbox";
  readonly id: string;
  /** The session's git worktree — point the agent's tools here. */
  readonly path: string;
  readonly branch: string;
  /** The resolved ref the session branched from, e.g. "origin/main". */
  readonly base: string;
  readonly baseWarning?: string;
  status(): Promise<string>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<string | null>;
  log(maxCount?: number): Promise<string>;
  /** Remove the worktree; the branch and its commits stay in the repo. */
  dispose(): Promise<void>;
}

/** Non-owning session over the caller's actual checkout. */
export interface ChildSession extends Session {
  /** The caller-supplied parent ref before it was frozen to `base`. */
  readonly parentRef: string;
  finalize(result: ChildSessionFinalizeRequest): Promise<ChildSessionFinalizeResult>;
}

export type ChildSessionFinalizeRequest =
  | { outcome: "success"; commitMessage: string }
  | { outcome: "failure"; detail?: string }
  | { outcome: "aborted"; detail?: string };

export type ChildSessionFinalizeResult =
  | {
      outcome: "changed";
      id: string;
      path: string;
      branch: string;
      base: string;
      parentRef: string;
      head: string;
      status: string;
      commit: string;
      worktreeRemoved: boolean;
      branchDeleted: false;
      preserved: boolean;
      /** Cleanup errors after the committed work was verified. */
      warnings?: string[];
    }
  | {
      outcome: "clean";
      id: string;
      path: string;
      branch: string;
      base: string;
      parentRef: string;
      head: string;
      status: "";
      commit: null;
      worktreeRemoved: boolean;
      branchDeleted: boolean;
      preserved: boolean;
      /** Cleanup errors after the clean worktree was verified. */
      warnings?: string[];
    }
  | {
      outcome: "preserved";
      reason: "failure" | "aborted" | "uncertain";
      id: string;
      path: string;
      branch: string;
      base: string;
      parentRef: string;
      head: string | null;
      status: string | null;
      commit: string | null;
      worktreeRemoved: boolean;
      branchDeleted: false;
      preserved: true;
      detail?: string;
    };

export interface ChildSessionOptions {
  readonly id: string;
  readonly parentRef: string;
}

const randomId = () => crypto.randomUUID().slice(0, 8);

const SESSION_ID_MAX_LENGTH = 64;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateSessionId(id: string): string {
  if (id.length === 0 || id.length > SESSION_ID_MAX_LENGTH) {
    throw new Error(
      `session id ${JSON.stringify(id)} must be 1-${SESSION_ID_MAX_LENGTH} ASCII characters`,
    );
  }
  if (/[/\\]/.test(id)) {
    throw new Error(`session id ${JSON.stringify(id)} must not contain path separators`);
  }
  if (/\s/.test(id)) {
    throw new Error(`session id ${JSON.stringify(id)} must not contain whitespace`);
  }
  if (id.startsWith("-")) {
    throw new Error(`session id ${JSON.stringify(id)} must not start with -`);
  }
  if (id.toUpperCase() === "HEAD") {
    throw new Error(`session id ${JSON.stringify(id)} must not use reserved git ref names`);
  }
  if (!sessionIdPattern.test(id)) {
    throw new Error(
      `session id ${JSON.stringify(id)} must start with an ASCII letter or digit and then use only letters, digits, ., _, or -`,
    );
  }
  if (id.includes("..")) {
    throw new Error(`session id ${JSON.stringify(id)} must not contain ..`);
  }
  if (id.endsWith(".")) {
    throw new Error(`session id ${JSON.stringify(id)} must not end with .`);
  }
  if (id.endsWith(".lock")) {
    throw new Error(`session id ${JSON.stringify(id)} must not end with .lock`);
  }
  return id;
}

function trimTrailingSlashes(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

function buildSessionPath(root: string, id: string): string {
  const baseRoot = trimTrailingSlashes(root);
  return baseRoot === "/" ? `/${id}` : `${baseRoot}/${id}`;
}

function buildSessionBranch(branchPrefix: string, id: string): string {
  return `${branchPrefix}${id}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the ref a new session branches from, per `config.base`.
 * May initialize/adopt the repo when the policy allows starting from scratch.
 */
async function readWorktreeEvidence(
  sb: Sandbox,
  repoDir: string,
  path: string,
): Promise<{ head: string; status: string } | null> {
  const worktree = await scm.inspectWorktree(sb, repoDir, path);
  if (!worktree) return null;
  return {
    head: await scm.resolveCommit(sb, path),
    status: await scm.status(sb, path),
  };
}

async function removeVerifiedWorktree(
  sb: Sandbox,
  repoDir: string,
  path: string,
): Promise<{ worktreeRemoved: boolean; warning?: string }> {
  try {
    await scm.removeWorktree(sb, repoDir, path);
    return { worktreeRemoved: true };
  } catch (error) {
    const warning = describeError(error);
    try {
      return {
        worktreeRemoved: (await scm.inspectWorktree(sb, repoDir, path)) === null,
        warning,
      };
    } catch (inspectionError) {
      return { worktreeRemoved: false, warning: `${warning}; ${describeError(inspectionError)}` };
    }
  }
}

function createSessionHandle(
  sb: Sandbox,
  id: string,
  branch: string,
  base: string,
  path: string,
  dispose: () => Promise<void>,
  baseWarning?: string,
): Session {
  return {
    mode: "sandbox",
    id,
    path,
    branch,
    base,
    ...(baseWarning ? { baseWarning } : {}),
    status: () => scm.status(sb, path),
    diff: () => scm.diff(sb, path),
    commitAll: (message) => scm.commitAll(sb, path, message),
    log: (maxCount) => scm.log(sb, path, maxCount),
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

async function finalizeChildSession(
  sb: Sandbox,
  config: SessionConfig,
  session: Pick<ChildSession, "id" | "path" | "branch" | "base" | "parentRef">,
  result: ChildSessionFinalizeRequest,
): Promise<ChildSessionFinalizeResult> {
  const evidence = await readWorktreeEvidence(sb, config.repoDir, session.path);
  if (!evidence) {
    return {
      outcome: "preserved",
      reason: result.outcome === "success" ? "uncertain" : result.outcome,
      id: session.id,
      path: session.path,
      branch: session.branch,
      base: session.base,
      parentRef: session.parentRef,
      head: null,
      status: null,
      commit: null,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail:
        result.outcome === "success"
          ? "child worktree is not registered; cannot verify finalization"
          : result.detail,
    };
  }

  if (result.outcome !== "success") {
    return {
      outcome: "preserved",
      reason: result.outcome,
      id: session.id,
      path: session.path,
      branch: session.branch,
      base: session.base,
      parentRef: session.parentRef,
      head: evidence.head,
      status: evidence.status,
      commit: null,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  if (evidence.status === "") {
    const cleanup = await removeVerifiedWorktree(sb, config.repoDir, session.path);
    const warnings = cleanup.warning ? [cleanup.warning] : [];
    if (!cleanup.worktreeRemoved) {
      return {
        outcome: "clean",
        id: session.id,
        path: session.path,
        branch: session.branch,
        base: session.base,
        parentRef: session.parentRef,
        head: evidence.head,
        status: "",
        commit: null,
        worktreeRemoved: false,
        branchDeleted: false,
        preserved: true,
        warnings,
      };
    }
    try {
      await scm.deleteProofCheckedDisposableBranch(
        sb,
        config.repoDir,
        session.branch,
        session.base,
      );
      return {
        outcome: "clean",
        id: session.id,
        path: session.path,
        branch: session.branch,
        base: session.base,
        parentRef: session.parentRef,
        head: evidence.head,
        status: "",
        commit: null,
        worktreeRemoved: true,
        branchDeleted: true,
        preserved: false,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      return {
        outcome: "clean",
        id: session.id,
        path: session.path,
        branch: session.branch,
        base: session.base,
        parentRef: session.parentRef,
        head: evidence.head,
        status: "",
        commit: null,
        worktreeRemoved: true,
        branchDeleted: false,
        preserved: true,
        warnings: [...warnings, describeError(error)],
      };
    }
  }

  let head: string | null = evidence.head;
  let status: string | null = evidence.status;
  let commit: string | null = null;
  let worktreeRemoved = false;

  const refreshEvidence = async () => {
    try {
      const refreshed = await readWorktreeEvidence(sb, config.repoDir, session.path);
      if (refreshed) {
        head = refreshed.head;
        status = refreshed.status;
        if (!commit && refreshed.status === "" && refreshed.head !== evidence.head) {
          commit = refreshed.head;
        }
      }
      return refreshed;
    } catch {
      return null;
    }
  };

  const preserveUncertain = (detail: string): ChildSessionFinalizeResult => ({
    outcome: "preserved",
    reason: "uncertain",
    id: session.id,
    path: session.path,
    branch: session.branch,
    base: session.base,
    parentRef: session.parentRef,
    head,
    status,
    commit,
    worktreeRemoved,
    branchDeleted: false,
    preserved: true,
    detail,
  });

  try {
    commit = await scm.commitAll(sb, session.path, result.commitMessage);
  } catch (error) {
    await refreshEvidence();
    return preserveUncertain(describeError(error));
  }

  if (!commit) {
    await refreshEvidence();
    return preserveUncertain("commitAll returned null for a dirty child worktree");
  }

  try {
    status = await scm.status(sb, session.path);
  } catch (error) {
    await refreshEvidence();
    return preserveUncertain(describeError(error));
  }

  if (status !== "") {
    await refreshEvidence();
    return preserveUncertain("child worktree remained dirty after commit");
  }

  try {
    head = await scm.resolveCommit(sb, config.repoDir, session.branch);
    commit = head;
  } catch (error) {
    const refreshed = await refreshEvidence();
    if (refreshed?.status === "") {
      commit = refreshed.head;
    }
    return preserveUncertain(describeError(error));
  }

  const cleanup = await removeVerifiedWorktree(sb, config.repoDir, session.path);
  worktreeRemoved = cleanup.worktreeRemoved;

  return {
    outcome: "changed",
    id: session.id,
    path: session.path,
    branch: session.branch,
    base: session.base,
    parentRef: session.parentRef,
    head,
    status: evidence.status,
    commit,
    worktreeRemoved,
    branchDeleted: false,
    preserved: !worktreeRemoved,
    ...(cleanup.warning ? { warnings: [cleanup.warning] } : {}),
  };
}

export async function createChildSession(
  sb: Sandbox,
  config: SessionConfig,
  options: ChildSessionOptions,
): Promise<ChildSession> {
  const id = validateSessionId(options.id);
  const path = buildSessionPath(config.root, id);
  const branch = buildSessionBranch(config.branchPrefix, id);
  const base = await scm.resolveCommit(sb, config.repoDir, options.parentRef);

  await scm.ensureIdentity(sb, config.repoDir, config.identity);
  await scm.addWorktree(sb, config.repoDir, path, branch, base);

  let finalized: Promise<ChildSessionFinalizeResult> | null = null;
  const child = {
    ...createSessionHandle(sb, id, branch, base, path, async () => {
      finalized ??= finalizeChildSession(sb, config, child, { outcome: "aborted" });
      await finalized;
    }),
    parentRef: options.parentRef,
    finalize: (result: ChildSessionFinalizeRequest) => {
      finalized ??= finalizeChildSession(sb, config, child, result);
      return finalized;
    },
  } satisfies ChildSession;
  return child;
}
