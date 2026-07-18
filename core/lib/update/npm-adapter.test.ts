import { describe, expect, test } from "bun:test";
import { createNpmInstaller, createNpmRegistryAdapter, detectPackageManager } from "./npm-adapter";

describe("npm update adapter", () => {
  test("reads a dist-tag without executing a shell", async () => {
    const adapter = createNpmRegistryAdapter({
      fetchImpl: async () => new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
    });
    expect(await adapter.latest("@scope/pkg", "next")).toBe("1.2.3");
  });
  test("selects bun on unix and passes argv", async () => {
    expect(detectPackageManager("darwin")).toBe("bun");
    const calls: unknown[] = [];
    const installer = createNpmInstaller({ command: async (file, args) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }, platform: "darwin" });
    await installer.install("@scope/pkg", "next");
    expect(calls).toEqual([["bun", ["add", "-g", "@scope/pkg@next"]]]);
  });
});
