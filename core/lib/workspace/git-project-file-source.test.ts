import { describe, expect, test } from "bun:test";
import { createGitProjectFileSource } from "./git-project-file-source";

describe("createGitProjectFileSource", () => {
  test("lists tracked and unignored files through the execution port", async () => {
    const commands: string[] = [];
    const source = createGitProjectFileSource(
      {
        executeCommand: async (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "README.md\0src/main.ts\0", stderr: "" };
        },
      },
      "/repo",
    );
    expect(await source.listFiles()).toEqual(["README.md", "src/main.ts"]);
    expect(commands[0]).toContain("ls-files --cached --others --exclude-standard -z");
  });

  test("hides adapter failures from completion", async () => {
    const source = createGitProjectFileSource(
      {
        executeCommand: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
      },
      "/repo",
    );
    expect(await source.listFiles()).toEqual([]);
  });
});
