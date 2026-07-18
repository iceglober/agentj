import { describe, expect, test } from "bun:test";

import type { Sandbox } from "../../sandbox";
import { createBashToolAdapter } from "./bash-tool-adapter";

const sandbox = (stdout: string): Sandbox => ({
  async executeCommand(command) {
    return {
      stdout: command.endsWith("&& emit-long") ? stdout : "",
      stderr: "",
      exitCode: 0,
    };
  },
  async readFile() {
    return "";
  },
  async writeFiles() {},
});

describe("bash output bounding", () => {
  test("applies the configured cap with the standard notice", async () => {
    const tools = await createBashToolAdapter(sandbox("x".repeat(30_100)), {
      root: "/repo",
      maxOutputChars: 30_000,
    });

    const result = (await tools.bash?.execute({ command: "emit-long" })) as { stdout: string };

    expect(result.stdout).toHaveLength(30_000);
    expect(result.stdout).toEndWith("[trunc 118 chars]");
  });

  test("the cap is configurable, and small outputs pass through untouched", async () => {
    const tools = await createBashToolAdapter(sandbox("y".repeat(5_000)), {
      root: "/repo",
      maxOutputChars: 2_000,
    });

    const result = (await tools.bash?.execute({ command: "emit-long" })) as { stdout: string };

    expect(result.stdout).toHaveLength(2_000);
    expect(result.stdout).toContain("[trunc ");
  });

  test("over-cap output spills in full and the notice points at the file", async () => {
    const spilled: Array<{ label: string; content: string }> = [];
    const tools = await createBashToolAdapter(sandbox("z".repeat(3_000)), {
      root: "/repo",
      maxOutputChars: 1_000,
      spill: (label, content) => {
        spilled.push({ label, content });
        return "/spill/0001-bash-stdout.txt";
      },
    });

    const result = (await tools.bash?.execute({ command: "emit-long" })) as { stdout: string };

    expect(spilled).toEqual([{ label: "bash-stdout", content: "z".repeat(3_000) }]);
    expect(result.stdout).toContain("[full output: /spill/0001-bash-stdout.txt");
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
  });

  test("a failed spill degrades to plain truncation", async () => {
    const tools = await createBashToolAdapter(sandbox("w".repeat(3_000)), {
      root: "/repo",
      maxOutputChars: 1_000,
      spill: () => undefined,
    });

    const result = (await tools.bash?.execute({ command: "emit-long" })) as { stdout: string };

    expect(result.stdout).toHaveLength(1_000);
    expect(result.stdout).toEndWith("[trunc 2019 chars]");
  });
});
