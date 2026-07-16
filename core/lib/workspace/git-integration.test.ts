import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SubagentTaskResult } from "../agent/delegate";
import { createHostExecutionEnvironment } from "./host-adapter";
import { createGitDelegationSnapshot, integrateGitDelegation } from "./git-integration";

async function git(root: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

test("snapshots dirty parent state and integrates child commits without changing the index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-integration-"));
  const child = `${root}-child`;
  try {
    await git(root, "init", "-q", "-b", "main");
    await git(root, "config", "user.name", "AgentJ Test");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(path.join(root, "source.txt"), "base\n");
    await git(root, "add", "source.txt");
    await git(root, "commit", "-qm", "initial");
    await writeFile(path.join(root, "source.txt"), "base dirty\n");
    const indexBefore = await git(root, "write-tree");

    const environment = await createHostExecutionEnvironment(root);
    const snapshot = await createGitDelegationSnapshot(environment, root, "test-session");
    await git(root, "worktree", "add", "-q", "-b", "agentj-child", child, snapshot.commit);
    await writeFile(path.join(child, "source.txt"), "base dirty\nchild\n");
    await git(child, "add", "source.txt");
    await git(child, "commit", "-qm", "child change");
    const childCommit = await git(child, "rev-parse", "HEAD");
    await git(root, "worktree", "remove", child);

    const result: SubagentTaskResult = {
      index: 0,
      id: "child",
      outcome: "changed",
      branch: "agentj-child",
      path: null,
      base: snapshot.commit,
      commit: childCommit,
      text: "done",
      error: null,
      recovery: {
        preserved: false,
        reason: null,
        parentRef: snapshot.commit,
        head: childCommit,
        status: "",
        worktreeRemoved: true,
        branchDeleted: false,
      },
    };
    await expect(
      integrateGitDelegation(environment, root, "test-session", snapshot, [result]),
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe("base dirty\nchild\n");
    expect(await git(root, "write-tree")).toBe(indexBefore);
    await expect(git(root, "show-ref", "--verify", snapshot.ref)).rejects.toThrow();
  } finally {
    await git(root, "worktree", "remove", "--force", child).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(child, { recursive: true, force: true });
  }
});
