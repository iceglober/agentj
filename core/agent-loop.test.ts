import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

test("rejects a non-Git launch directory before sandbox, session, or model setup", async () => {
  const hostDir = await mkdtemp(path.join(tmpdir(), "agentj-agent-loop-test-"));
  const entrypoint = path.resolve(import.meta.dir, "agent-loop.ts");

  try {
    const child = Bun.spawn({
      cmd: [process.execPath, entrypoint],
      cwd: hostDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toStartWith(
      "[setup] Microsandbox projectDir is not inside a Git worktree",
    );
    expect(stderr).not.toContain("[session]");
    expect(stderr).not.toContain("[prompt]");
    expect(stderr).not.toContain("[model]");
    expect(stderr).not.toContain("[tool]");
    expect(await readdir(hostDir)).toEqual([]);
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
});

test("--help exits 0 with usage before any setup, even from a non-Git cwd", async () => {
  const hostDir = await mkdtemp(path.join(tmpdir(), "agentj-agent-loop-help-"));
  const entrypoint = path.resolve(import.meta.dir, "agent-loop.ts");

  try {
    const child = Bun.spawn({
      cmd: [process.execPath, entrypoint, "--help"],
      cwd: hostDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stderr).toBe("");
    expect(stderr).not.toContain("[setup]");
    expect(stderr).not.toContain("[session]");
    expect(stderr).not.toContain("[prompt]");
    expect(stderr).not.toContain("[tool]");
    expect(await readdir(hostDir)).toEqual([]);
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
});
