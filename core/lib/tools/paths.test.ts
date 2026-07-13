import { describe, expect, test } from "bun:test";
import type { Sandbox, SandboxCommandResult } from "../sandbox";
import { confineSandboxFiles, resolveWithinRoot } from "./paths";

class FakeSandbox implements Sandbox {
  readonly executeCalls: string[] = [];
  readonly readCalls: string[] = [];
  readonly writeCalls: Array<Array<{ path: string; content: string | Buffer }>> = [];

  async executeCommand(command: string): Promise<SandboxCommandResult> {
    this.executeCalls.push(command);
    return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
  }

  async readFile(path: string): Promise<string> {
    this.readCalls.push(path);
    return `read:${path}`;
  }

  async writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
    this.writeCalls.push(files);
  }
}

describe("resolveWithinRoot", () => {
  test("joins relative paths under a normalized POSIX root", () => {
    expect(resolveWithinRoot("/repo/worktree", "src/agent.ts")).toBe(
      "/repo/worktree/src/agent.ts",
    );
  });

  test("missing, empty, and root candidates resolve to the normalized root", () => {
    expect(resolveWithinRoot("/repo/worktree", undefined)).toBe("/repo/worktree");
    expect(resolveWithinRoot("/repo/worktree", "")).toBe("/repo/worktree");
    expect(resolveWithinRoot("/repo/worktree", "   ")).toBe("/repo/worktree");
    expect(resolveWithinRoot("/repo/worktree", "/repo/worktree")).toBe(
      "/repo/worktree",
    );
  });

  test("normalized in-root dot segments that stay inside succeed", () => {
    expect(resolveWithinRoot("/repo/worktree", "./src/../src/index.ts")).toBe(
      "/repo/worktree/src/index.ts",
    );
    expect(resolveWithinRoot("/repo/worktree", "nested/..")).toBe("/repo/worktree");
  });

  test("absolute in-root paths succeed", () => {
    expect(resolveWithinRoot("/repo/worktree", "/repo/worktree/src/index.ts")).toBe(
      "/repo/worktree/src/index.ts",
    );
  });

  test("rejects the root-sibling prefix trap", () => {
    expect(() => resolveWithinRoot("/root", "/root-sibling/file.txt")).toThrow(
      "Path escapes sandbox root",
    );
  });
});

describe("confineSandboxFiles", () => {
  test("rejects relative and absolute escapes before calling the sandbox", async () => {
    const sandbox = new FakeSandbox();
    const confined = confineSandboxFiles(sandbox, "/repo/worktree");

    expect(() => confined.readFile("../secret.txt")).toThrow("Path escapes sandbox root");
    expect(() => confined.readFile("/tmp/secret.txt")).toThrow("Path escapes sandbox root");

    expect(sandbox.readCalls).toEqual([]);
  });

  test("resolves read and write paths, preserves content, and passes executeCommand through unchanged", async () => {
    const sandbox = new FakeSandbox();
    const confined = confineSandboxFiles(sandbox, "/repo/worktree");
    const buffer = Buffer.from("buffer payload");
    const command = "git status --short";

    await expect(confined.readFile("./src/../src/index.ts")).resolves.toBe(
      "read:/repo/worktree/src/index.ts",
    );

    await confined.writeFiles([
      { path: "notes.txt", content: "plain text" },
      { path: "/repo/worktree/bin/data.bin", content: buffer },
    ]);

    await expect(confined.executeCommand(command)).resolves.toEqual({
      stdout: `ran:${command}`,
      stderr: "",
      exitCode: 0,
    });

    expect(sandbox.readCalls).toEqual(["/repo/worktree/src/index.ts"]);
    expect(sandbox.writeCalls).toHaveLength(1);
    expect(sandbox.writeCalls[0]).toEqual([
      { path: "/repo/worktree/notes.txt", content: "plain text" },
      { path: "/repo/worktree/bin/data.bin", content: buffer },
    ]);
    expect(sandbox.writeCalls[0]?.[1]?.content).toBe(buffer);
    expect(sandbox.executeCalls).toEqual([command]);
  });

  test("one invalid write in a batch prevents all underlying writes", async () => {
    const sandbox = new FakeSandbox();
    const confined = confineSandboxFiles(sandbox, "/repo/worktree");

    expect(() =>
      confined.writeFiles([
        { path: "safe.txt", content: "ok" },
        { path: "../escape.txt", content: "nope" },
      ]),
    ).toThrow("Path escapes sandbox root");

    expect(sandbox.writeCalls).toEqual([]);
  });
});
