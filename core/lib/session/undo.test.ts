import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostExecutionEnvironment } from "../workspace/host-adapter";
import { createUndoStack } from "./undo";

async function git(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-undo-"));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "AgentJ Test");
  await git(root, "config", "user.email", "test@example.com");
  await writeFile(path.join(root, "file.txt"), "one\n");
  await git(root, "add", "file.txt");
  await git(root, "commit", "-qm", "initial");
  return root;
}

test("undo and redo restore file states without touching HEAD, index, or branch", async () => {
  const root = await makeRepo();
  try {
    const stack = createUndoStack(await createHostExecutionEnvironment(root), root, "s1");
    const headBefore = await git(root, "rev-parse", "HEAD");

    await stack.snapshot("turn 1");
    await writeFile(path.join(root, "file.txt"), "two\n");
    await writeFile(path.join(root, "new.txt"), "created\n");

    // Undo captures the drifted state (redoable), then restores turn 1.
    await expect(stack.undo()).resolves.toBe("turn 1");
    await expect(readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("one\n");
    await expect(readFile(path.join(root, "new.txt"), "utf8")).rejects.toThrow();

    // Redo brings the edits back, including the created file.
    await expect(stack.redo()).resolves.toBe("pre-undo");
    await expect(readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("two\n");
    await expect(readFile(path.join(root, "new.txt"), "utf8")).resolves.toBe("created\n");

    // HEAD, branch, and the user's index are untouched throughout.
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "branch", "--show-current")).toBe("main");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("");

    await stack.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bottom of stack, no-op snapshots, and redo invalidation on new changes", async () => {
  const root = await makeRepo();
  try {
    const stack = createUndoStack(await createHostExecutionEnvironment(root), root, "s2");

    // Bottom of stack: undo captures the current tree but has nowhere to go.
    await expect(stack.undo()).resolves.toBeNull();
    // The pre-undo capture already holds this tree — same-tree snapshots dedupe.
    await expect(stack.snapshot("same")).resolves.toBeNull();
    await writeFile(path.join(root, "file.txt"), "changed\n");
    await expect(stack.snapshot("changed")).resolves.not.toBeNull();

    await writeFile(path.join(root, "file.txt"), "two\n");
    await stack.undo();
    await writeFile(path.join(root, "file.txt"), "three\n"); // drift after restore
    await expect(stack.redo()).resolves.toBeNull(); // redo invalidated

    await stack.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose prunes refs beyond the keep window", async () => {
  const root = await makeRepo();
  try {
    const stack = createUndoStack(await createHostExecutionEnvironment(root), root, "s3");
    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(root, "file.txt"), `state ${i}\n`);
      await stack.snapshot(`turn ${i}`);
    }
    await stack.dispose(2);
    const refs = (await git(root, "for-each-ref", "refs/agentj/undo/s3", "--format=%(refname)"))
      .split("\n")
      .filter(Boolean);
    expect(refs).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed session continues the undo ref counter instead of colliding", async () => {
  const root = await makeRepo();
  try {
    const environment = await createHostExecutionEnvironment(root);
    const first = createUndoStack(environment, root, "resumed");
    await first.snapshot("turn 1");
    await writeFile(path.join(root, "file.txt"), "two\n");
    await first.snapshot("turn 2");

    // Same session id, fresh process: the previous run's refs still exist.
    // Before the fix this threw "cannot lock ref ... reference already exists".
    const second = createUndoStack(environment, root, "resumed");
    await writeFile(path.join(root, "file.txt"), "three\n");
    await expect(second.snapshot("turn 3")).resolves.toMatchObject({
      ref: "refs/agentj/undo/resumed/3",
    });

    // Prior-run snapshots are loaded and stay undoable across the resume.
    await expect(second.undo()).resolves.toBe("turn 2");
    await expect(readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("two\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
