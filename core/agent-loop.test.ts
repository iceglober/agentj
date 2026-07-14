import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

test("rejects a non-Git launch directory before sandbox, session, or model setup", async () => {
  const hostDir = await mkdtemp(path.join(tmpdir(), "agentj-agent-loop-test-"));
  const entrypoint = path.resolve(import.meta.dir, "agent-loop.ts");

  try {
    const child = Bun.spawn({
      cmd: [process.execPath, entrypoint, "inspect the project"],
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
    const transcript = `${stdout}${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(transcript).not.toContain("Session:");
    expect(transcript).not.toContain("Tool:");
    expect(transcript).not.toContain("Result:");
    expect(transcript).not.toContain("Commit:");
    await expect(access(path.join(hostDir, ".git"))).rejects.toThrow();
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
    const transcript = `${stdout}${stderr}`;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("agentj 0.0.0");
    expect(stdout).toContain("--help, -h");
    expect(stderr).toBe("");
    expect(transcript).not.toContain("Session:");
    expect(transcript).not.toContain("Tool:");
    expect(transcript).not.toContain("Result:");
    expect(transcript).not.toContain("Commit:");
    await expect(access(path.join(hostDir, ".git"))).rejects.toThrow();
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
});
