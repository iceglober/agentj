import { describe, expect, test } from "bun:test";
import { createNpmInstaller, createNpmRegistryAdapter, detectPackageManager } from "./npm-adapter";

describe("npm update adapter", () => {
  test("reads a scoped dist-tag without executing a shell", async () => {
    const adapter = createNpmRegistryAdapter(
      async () => new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
    );
    expect(await adapter.latest("@scope/pkg", "next")).toBe("1.2.3");
  });

  test("only updates recognized global installs with argv", async () => {
    expect(
      detectPackageManager("/Users/a/.bun/install/global/node_modules/@glrs-dev/glorious"),
    ).toBe("bun");
    expect(detectPackageManager("/usr/local/lib/node_modules/@glrs-dev/glorious")).toBe("npm");
    expect(detectPackageManager("/repo/glorious")).toBeUndefined();
    const calls: unknown[] = [];
    const installer = createNpmInstaller({
      packageRoot: "/usr/local/lib/node_modules/@glrs-dev/glorious",
      command: async (file, args) => {
        calls.push([file, args]);
        return { stderr: "", exitCode: 0 };
      },
    });
    await installer?.install("@scope/pkg", "next");
    expect(calls).toEqual([["npm", ["install", "--global", "@scope/pkg@next"]]]);
  });
});
