import { expect, test } from "bun:test";
import type { Sandbox } from "../../sandbox";
import { createReadTools } from ".";

test("readFile is confined to the configured root", async () => {
  const reads: string[] = [];
  const sandbox: Sandbox = {
    async executeCommand() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile(path) {
      reads.push(path);
      return "contents";
    },
    async writeFiles() {
      throw new Error("not used");
    },
  };
  const { readFile } = createReadTools(sandbox, { root: "/repo" });
  await expect(readFile.execute({ path: "src/a.ts" })).resolves.toBe("contents");
  expect(reads).toEqual(["/repo/src/a.ts"]);
  expect(await readFile.execute({ path: "../secret" })).toContain("ERROR:");
  expect(reads).toHaveLength(1);
});
