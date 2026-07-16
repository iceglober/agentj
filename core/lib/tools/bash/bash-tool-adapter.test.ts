import { describe, expect, test } from "bun:test";

import type { Sandbox } from "../../sandbox";
import { createBashToolAdapter, truncateToolOutput } from "./bash-tool-adapter";

describe("truncateToolOutput", () => {
  test("keeps bash results within the output limit with the standard notice", () => {
    const result = truncateToolOutput("x".repeat(30_100));
    expect(result).toHaveLength(30_000);
    expect(result).toEndWith("[trunc 118 chars]");
  });

  test("applies the standard notice to executed bash tool results", async () => {
    const sandbox: Sandbox = {
      async executeCommand(command) {
        return {
          stdout: command.endsWith("&& emit-long") ? "x".repeat(30_100) : "",
          stderr: "",
          exitCode: 0,
        };
      },
      async readFile() {
        return "";
      },
      async writeFiles() {},
    };
    const tools = await createBashToolAdapter(sandbox, { root: "/repo" });

    const result = (await tools.bash?.execute({ command: "emit-long" })) as { stdout: string };

    expect(result.stdout).toHaveLength(30_000);
    expect(result.stdout).toEndWith("[trunc 118 chars]");
  });
});
