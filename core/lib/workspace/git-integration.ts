import type { Sandbox } from "../sandbox";
import { shq } from "../shell";

export interface GitDelegationSnapshot {
  id: string;
  commit: string;
  tree: string;
  ref: string;
  scratch: string;
}

export interface GitDelegationResult {
  index: number;
  outcome: "changed" | "clean" | "failure" | "aborted";
  commit: string | null;
  branch: string | null;
  /** Keep the branch while a child worktree is preserved for recovery. */
  preserved: boolean;
}

const run = async (environment: Sandbox, command: string): Promise<string> => {
  const result = await environment.executeCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `command exited ${result.exitCode}`);
  }
  return result.stdout.trim();
};

const tryRun = async (environment: Sandbox, command: string): Promise<void> => {
  await environment.executeCommand(command).catch(() => undefined);
};

const git = (cwd: string, args: string): string => `git -C ${shq(cwd)} ${args}`;

export async function createGitDelegationSnapshot(
  environment: Sandbox,
  parentRoot: string,
  sessionId: string,
): Promise<GitDelegationSnapshot> {
  const batchId = crypto.randomUUID();
  const scratch = `/tmp/agentj-${sessionId}-${batchId}`;
  const index = `${scratch}/snapshot.index`;
  const ref = `refs/agentj/sessions/${sessionId}/snapshots/${batchId}`;
  await run(environment, `mkdir -p ${shq(scratch)}`);
  const head = await run(environment, git(parentRoot, "rev-parse -q --verify 'HEAD^{commit}'"));
  await run(
    environment,
    `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, `read-tree ${shq(`${head}^{tree}`)}`)}`,
  );
  await run(environment, `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, "add -A -- .")}`);
  const tree = await run(
    environment,
    `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, "write-tree")}`,
  );
  const commit = await run(
    environment,
    `GIT_AUTHOR_NAME=agentj GIT_AUTHOR_EMAIL=agentj@sandbox.local ` +
      `GIT_COMMITTER_NAME=agentj GIT_COMMITTER_EMAIL=agentj@sandbox.local ` +
      git(
        parentRoot,
        `commit-tree ${shq(tree)} -p ${shq(head)} -m ${shq(`agentj delegation snapshot ${batchId}`)}`,
      ),
  );
  await run(
    environment,
    git(
      parentRoot,
      `update-ref -m ${shq("agentj delegation snapshot")} ${shq(ref)} ${shq(commit)} ''`,
    ),
  );
  await run(environment, `rm -f ${shq(index)} ${shq(`${index}.lock`)}`);
  return { id: batchId, commit, tree, ref, scratch };
}

async function captureTree(
  environment: Sandbox,
  parentRoot: string,
  baseCommit: string,
  index: string,
): Promise<string> {
  await run(
    environment,
    `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, `read-tree ${shq(`${baseCommit}^{tree}`)}`)}`,
  );
  await run(environment, `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, "add -A -- .")}`);
  return run(environment, `GIT_INDEX_FILE=${shq(index)} ${git(parentRoot, "write-tree")}`);
}

export async function integrateGitDelegation(
  environment: Sandbox,
  parentRoot: string,
  sessionId: string,
  snapshot: GitDelegationSnapshot,
  results: readonly GitDelegationResult[],
): Promise<{ outcome: "applied" | "clean" | "blocked"; detail: string | null }> {
  if (results.some((result) => result.outcome === "failure" || result.outcome === "aborted")) {
    return { outcome: "blocked", detail: "one or more subagents did not complete" };
  }
  const changed = results.filter(
    (result): result is GitDelegationResult & { commit: string } =>
      result.outcome === "changed" && result.commit !== null,
  );
  if (changed.length === 0) return { outcome: "clean", detail: null };

  const integrationIndex = `${snapshot.scratch}/integration.index`;
  const verifyIndex = `${snapshot.scratch}/verify.index`;
  try {
    await run(
      environment,
      `GIT_INDEX_FILE=${shq(integrationIndex)} ${git(parentRoot, `read-tree ${shq(`${snapshot.commit}^{tree}`)}`)}`,
    );
    for (const result of changed.sort((left, right) => left.index - right.index)) {
      const patch = `${snapshot.scratch}/child-${result.index}.patch`;
      await run(
        environment,
        git(
          parentRoot,
          `diff-tree --no-commit-id --no-ext-diff --no-textconv --no-renames --binary --full-index -p --output=${shq(patch)} ${shq(snapshot.commit)} ${shq(result.commit)} --`,
        ),
      );
      await run(
        environment,
        `GIT_INDEX_FILE=${shq(integrationIndex)} ${git(parentRoot, `apply --cached --check --binary ${shq(patch)}`)}`,
      );
      await run(
        environment,
        `GIT_INDEX_FILE=${shq(integrationIndex)} ${git(parentRoot, `apply --cached --binary ${shq(patch)}`)}`,
      );
    }
    const integratedTree = await run(
      environment,
      `GIT_INDEX_FILE=${shq(integrationIndex)} ${git(parentRoot, "write-tree")}`,
    );
    const currentTree = await captureTree(environment, parentRoot, snapshot.commit, verifyIndex);
    if (currentTree !== snapshot.tree) {
      return { outcome: "blocked", detail: "parent workspace changed during delegation" };
    }

    const integratedCommit = await run(
      environment,
      `GIT_AUTHOR_NAME=agentj GIT_AUTHOR_EMAIL=agentj@sandbox.local ` +
        `GIT_COMMITTER_NAME=agentj GIT_COMMITTER_EMAIL=agentj@sandbox.local ` +
        git(
          parentRoot,
          `commit-tree ${shq(integratedTree)} -p ${shq(snapshot.commit)} -m ${shq("agentj integrated delegation")}`,
        ),
    );
    const integrationRef = `refs/agentj/sessions/${sessionId}/integrations/${crypto.randomUUID()}`;
    await run(
      environment,
      git(parentRoot, `update-ref ${shq(integrationRef)} ${shq(integratedCommit)} ''`),
    );
    const aggregatePatch = `${snapshot.scratch}/aggregate.patch`;
    await run(
      environment,
      git(
        parentRoot,
        `diff-tree --no-commit-id --no-ext-diff --no-textconv --no-renames --binary --full-index -p --output=${shq(aggregatePatch)} ${shq(snapshot.commit)} ${shq(integratedCommit)} --`,
      ),
    );
    await run(environment, git(parentRoot, `apply --check --binary ${shq(aggregatePatch)}`));
    await run(environment, git(parentRoot, `apply --binary ${shq(aggregatePatch)}`));
    const appliedTree = await captureTree(
      environment,
      parentRoot,
      snapshot.commit,
      `${snapshot.scratch}/applied.index`,
    );
    if (appliedTree !== integratedTree) {
      return { outcome: "blocked", detail: "integrated workspace verification failed" };
    }
    for (const result of changed) {
      if (result.branch && !result.preserved) {
        await tryRun(
          environment,
          git(
            parentRoot,
            `update-ref -d ${shq(`refs/heads/${result.branch}`)} ${shq(result.commit)}`,
          ),
        );
      }
    }
    await tryRun(
      environment,
      git(parentRoot, `update-ref -d ${shq(integrationRef)} ${shq(integratedCommit)}`),
    );
    await tryRun(
      environment,
      git(parentRoot, `update-ref -d ${shq(snapshot.ref)} ${shq(snapshot.commit)}`),
    );
    await tryRun(environment, `rm -rf ${shq(snapshot.scratch)}`);
    return { outcome: "applied", detail: `${changed.length} subagent commit(s) integrated` };
  } catch (error) {
    return {
      outcome: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
