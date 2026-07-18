import { expect, test } from "bun:test";
import type { Sandbox } from "../../sandbox";
import { createReadTools } from ".";

const sandboxWith = (files: Record<string, string>, reads: string[] = []): Sandbox => ({
  async executeCommand() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async readFile(path) {
    reads.push(path);
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  },
  async writeFiles() {
    throw new Error("not used");
  },
});

test("readFile is confined to the configured root", async () => {
  const reads: string[] = [];
  const sandbox = sandboxWith({ "/repo/src/a.ts": "contents" }, reads);
  const { readFile } = createReadTools(sandbox, { root: "/repo", maxOutputChars: 30_000 });
  await expect(readFile.execute({ path: "src/a.ts" })).resolves.toBe("contents");
  expect(reads).toEqual(["/repo/src/a.ts"]);
  expect(await readFile.execute({ path: "../secret" })).toContain("ERROR:");
  expect(reads).toHaveLength(1);
});

test("offset/limit slice 1-based line ranges", async () => {
  const sandbox = sandboxWith({ "/repo/f.txt": "l1\nl2\nl3\nl4\nl5" });
  const { readFile } = createReadTools(sandbox, { root: "/repo", maxOutputChars: 30_000 });
  expect(await readFile.execute({ path: "f.txt", offset: 2, limit: 2 })).toBe("l2\nl3");
  expect(await readFile.execute({ path: "f.txt", offset: 4 })).toBe("l4\nl5");
  expect(await readFile.execute({ path: "f.txt", limit: 1 })).toBe("l1");
});

test("offset past EOF returns a notice, not an error", async () => {
  const sandbox = sandboxWith({ "/repo/f.txt": "l1\nl2" });
  const { readFile } = createReadTools(sandbox, { root: "/repo", maxOutputChars: 30_000 });
  const result = (await readFile.execute({ path: "f.txt", offset: 9 })) as string;
  expect(result).toContain("[empty: offset 9 is past the last line (2)]");
  expect(result).not.toContain("ERROR:");
});

test("over-cap content truncates with a re-read hint", async () => {
  const sandbox = sandboxWith({ "/repo/big.txt": "x".repeat(5_000) });
  const { readFile } = createReadTools(sandbox, { root: "/repo", maxOutputChars: 1_000 });
  const result = (await readFile.execute({ path: "big.txt" })) as string;
  expect(result).toContain("[trunc ");
  expect(result).toContain("[hint: re-read with offset/limit");
});

test("explicit offset/limit reads skip the hint", async () => {
  const sandbox = sandboxWith({ "/repo/big.txt": `${"y".repeat(5_000)}\nend` });
  const { readFile } = createReadTools(sandbox, { root: "/repo", maxOutputChars: 1_000 });
  const result = (await readFile.execute({ path: "big.txt", offset: 1, limit: 1 })) as string;
  expect(result).toContain("[trunc ");
  expect(result).not.toContain("[hint:");
});

test("absolute paths under an extra root are readable; other escapes still fail", async () => {
  const sandbox = sandboxWith({ "/spill/0001-bash-stdout.txt": "spilled" });
  const { readFile } = createReadTools(sandbox, {
    root: "/repo",
    extraRoots: ["/spill"],
    maxOutputChars: 30_000,
  });
  await expect(readFile.execute({ path: "/spill/0001-bash-stdout.txt" })).resolves.toBe("spilled");
  expect(await readFile.execute({ path: "/etc/passwd" })).toContain("ERROR:");
  // Relative paths never resolve against extra roots.
  expect(await readFile.execute({ path: "0001-bash-stdout.txt" })).toContain("ERROR:");
});
