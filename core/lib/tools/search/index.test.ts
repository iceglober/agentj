import { describe, expect, test } from "bun:test";
import { rgPath } from "@vscode/ripgrep";
import type z from "zod";
import type { ToolDef } from "../../llm";
import type { Sandbox, SandboxCommandResult } from "../../sandbox";
import { shq } from "../../shell";
import { createSearchTools } from "./index";

const RG = shq(rgPath);
const GIT_GLOB = `--glob ${shq("!.git")}`;
const GREP_HEAD = "--with-filename --line-number --no-heading --color=never";

function grepCommand(path: string, pattern: string, maxResults: number, extra = "") {
  const flags = [GREP_HEAD, extra, GIT_GLOB].filter(Boolean).join(" ");
  return `${RG} ${flags} -e ${shq(pattern)} ${shq(path)} | head -n ${maxResults + 1}`;
}

function globCommand(path: string, pattern: string, maxResults: number, extra = "") {
  const flags = ["--files --sortr modified", extra, `--glob ${shq(pattern)}`, GIT_GLOB]
    .filter(Boolean)
    .join(" ");
  return `cd ${shq(path)} && ${RG} ${flags} | head -n ${maxResults + 1}`;
}

function makeSandbox(
  respond: (command: string) => Promise<SandboxCommandResult> | SandboxCommandResult,
): Sandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async executeCommand(command) {
      commands.push(command);
      return await respond(command);
    },
    async readFile() {
      throw new Error("readFile should not be called by search tools");
    },
    async writeFiles() {
      throw new Error("writeFiles should not be called by search tools");
    },
  };
}

async function executeTool<S extends z.ZodType>(tool: ToolDef<S>, input: z.input<S>) {
  return (await tool.execute(tool.inputSchema.parse(input))) as string;
}

describe("createSearchTools", () => {
  test("grep resolves omitted, relative, and in-root absolute paths before executing", async () => {
    const root = "/repo/worktree";
    const sandbox = makeSandbox(() => ({ stdout: "match\n", stderr: "", exitCode: 0 }));
    const { grep } = createSearchTools(sandbox, { root });

    await executeTool(grep, { pattern: "needle", maxResults: 5 });
    await executeTool(grep, { pattern: "needle", path: "src", maxResults: 5 });
    await executeTool(grep, {
      pattern: "needle",
      path: "/repo/worktree/src/nested",
      maxResults: 5,
    });

    expect(sandbox.commands).toEqual([
      grepCommand(root, "needle", 5),
      grepCommand(`${root}/src`, "needle", 5),
      grepCommand(`${root}/src/nested`, "needle", 5),
    ]);
  });

  test("glob resolves omitted, relative, and in-root absolute paths before executing", async () => {
    const root = "/repo/worktree";
    const sandbox = makeSandbox(() => ({ stdout: "file.ts\n", stderr: "", exitCode: 0 }));
    const { glob } = createSearchTools(sandbox, { root });

    await executeTool(glob, { pattern: "**/*.ts", maxResults: 3 });
    await executeTool(glob, { pattern: "**/*.ts", path: "src", maxResults: 3 });
    await executeTool(glob, {
      pattern: "**/*.ts",
      path: "/repo/worktree/src/nested",
      maxResults: 3,
    });

    expect(sandbox.commands).toEqual([
      globCommand(root, "**/*.ts", 3),
      globCommand(`${root}/src`, "**/*.ts", 3),
      globCommand(`${root}/src/nested`, "**/*.ts", 3),
    ]);
  });

  test("invalid grep and glob paths return errors without invoking the sandbox", async () => {
    const root = "/repo/worktree";
    const invalidPaths = ["..", "/tmp/outside", "/repo/worktree-sibling"];

    for (const path of invalidPaths) {
      const grepSandbox = makeSandbox(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      const { grep } = createSearchTools(grepSandbox, { root });
      const grepResult = await executeTool(grep, { pattern: "needle", path, maxResults: 5 });
      expect(grepResult).toBe(`ERROR: Path escapes sandbox root: ${path} is outside ${root}`);
      expect(grepSandbox.commands).toHaveLength(0);

      const globSandbox = makeSandbox(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      const { glob } = createSearchTools(globSandbox, { root });
      const globResult = await executeTool(glob, { pattern: "**/*.ts", path, maxResults: 5 });
      expect(globResult).toBe(`ERROR: Path escapes sandbox root: ${path} is outside ${root}`);
      expect(globSandbox.commands).toHaveLength(0);
    }
  });

  test("grep maps flags and preserves quoting-sensitive command construction", async () => {
    const root = "/repo/work tree";
    const sandbox = makeSandbox(() => ({ stdout: "quoted\n", stderr: "", exitCode: 0 }));
    const { grep } = createSearchTools(sandbox, { root });

    const result = await executeTool(grep, {
      pattern: "it's literal",
      path: "src dir",
      include: "*.test.ts",
      ignoreCase: true,
      fixedString: true,
      maxResults: 7,
    });

    expect(result).toBe("quoted");
    expect(sandbox.commands).toEqual([
      grepCommand(
        `${root}/src dir`,
        "it's literal",
        7,
        `--ignore-case --fixed-strings --glob ${shq("*.test.ts")}`,
      ),
    ]);
  });

  test("includeIgnored opts grep and glob into git-ignored + hidden files", async () => {
    const root = "/repo/worktree";
    const sandbox = makeSandbox(() => ({ stdout: "hit\n", stderr: "", exitCode: 0 }));
    const { grep, glob } = createSearchTools(sandbox, { root });

    await executeTool(grep, { pattern: "needle", includeIgnored: true, maxResults: 5 });
    await executeTool(glob, { pattern: "**/*.ts", includeIgnored: true, maxResults: 3 });

    expect(sandbox.commands).toEqual([
      grepCommand(root, "needle", 5, "--no-ignore --hidden"),
      globCommand(root, "**/*.ts", 3, "--no-ignore --hidden"),
    ]);
  });

  test("grep surfaces a real ripgrep error (exit > 1)", async () => {
    const sandbox = makeSandbox(() => ({ stdout: "", stderr: "regex parse error", exitCode: 2 }));
    const { grep } = createSearchTools(sandbox, { root: "/repo/worktree" });

    const result = await executeTool(grep, { pattern: "(", maxResults: 5 });

    expect(result).toBe("ERROR: regex parse error");
  });

  test("grep keeps no-match behavior for exit code 1", async () => {
    const sandbox = makeSandbox(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    const { grep } = createSearchTools(sandbox, { root: "/repo/worktree" });

    const result = await executeTool(grep, { pattern: "needle", maxResults: 5 });

    expect(result).toBe("No matches.");
    expect(sandbox.commands).toHaveLength(1);
  });

  test("glob keeps no-match behavior when no files are returned", async () => {
    const sandbox = makeSandbox(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const { glob } = createSearchTools(sandbox, { root: "/repo/worktree" });

    const result = await executeTool(glob, { pattern: "**/*.ts", maxResults: 5 });

    expect(result).toBe("No files match.");
    expect(sandbox.commands).toHaveLength(1);
  });
});
