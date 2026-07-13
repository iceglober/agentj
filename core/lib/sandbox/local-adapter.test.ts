import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxProviderLocal } from "./local-adapter";

async function withTempBase(run: (base: string) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), "agentj-local-adapter-test-"));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

describe("createSandboxProviderLocal", () => {
  test("creates unique owned roots under the supplied base", async () => {
    await withTempBase(async (base) => {
      const provider = createSandboxProviderLocal({ base, prefix: "lane-" });
      const first = await provider();
      const second = await provider();

      try {
        expect(first.root).toStartWith(`${base}${path.sep}lane-`);
        expect(second.root).toStartWith(`${base}${path.sep}lane-`);
        expect(first.root).not.toBe(second.root);
        expect(await pathExists(first.root)).toBe(true);
        expect(await pathExists(second.root)).toBe(true);
      } finally {
        await first[Symbol.asyncDispose]();
        await second[Symbol.asyncDispose]();
      }
    });
  });

  test("executes commands in the sandbox root and returns stdout, stderr, and exit codes", async () => {
    await withTempBase(async (base) => {
      const sandbox = await createSandboxProviderLocal({ base, prefix: "exec-" })();

      try {
        const success = await sandbox.executeCommand(
          "printf '%s\n' \"$PWD\"; printf 'stdout-data'; printf 'stderr-data' >&2",
        );
        const failure = await sandbox.executeCommand(
          "printf 'bad-news' >&2; exit 7",
        );

        const [reportedPwd, reportedStdout] = success.stdout.split("\n");

        expect(await realpath(reportedPwd ?? "")).toBe(await realpath(sandbox.root));
        expect(reportedStdout).toBe("stdout-data");
        expect(success.stderr).toBe("stderr-data");
        expect(success.exitCode).toBe(0);
        expect(failure).toEqual({
          stdout: "",
          stderr: "bad-news",
          exitCode: 7,
        });
      } finally {
        await sandbox[Symbol.asyncDispose]();
      }
    });
  });

  test("writes nested string and buffer files and reads relative and absolute in-root paths", async () => {
    await withTempBase(async (base) => {
      const sandbox = await createSandboxProviderLocal({ base, prefix: "files-" })();
      const textPath = "nested/deep/note.txt";
      const bufferPath = path.join(sandbox.root, "nested", "deep", "data.bin");
      const payload = Buffer.from([0, 1, 2, 3, 255]);

      try {
        await sandbox.writeFiles([
          { path: textPath, content: "hello from local adapter" },
          { path: bufferPath, content: payload },
        ]);

        await expect(sandbox.readFile(textPath)).resolves.toBe("hello from local adapter");
        await expect(sandbox.readFile(path.join(sandbox.root, textPath))).resolves.toBe(
          "hello from local adapter",
        );
        await expect(readFile(bufferPath)).resolves.toEqual(payload);
      } finally {
        await sandbox[Symbol.asyncDispose]();
      }
    });
  });

  test("rejects traversal and sibling absolute paths before IO", async () => {
    await withTempBase(async (base) => {
      const sandbox = await createSandboxProviderLocal({ base, prefix: "guard-" })();
      const sibling = path.join(base, "sibling.txt");
      const escaped = path.join(base, "escaped.txt");

      await writeFile(sibling, "keep me");

      try {
        await expect(sandbox.readFile("../sibling.txt")).rejects.toThrow(
          "Path escapes sandbox root",
        );
        await expect(sandbox.readFile(sibling)).rejects.toThrow("Path escapes sandbox root");
        await expect(
          sandbox.writeFiles([{ path: "../escaped.txt", content: "should not write" }]),
        ).rejects.toThrow("Path escapes sandbox root");
        await expect(
          sandbox.writeFiles([{ path: sibling, content: "should not overwrite" }]),
        ).rejects.toThrow("Path escapes sandbox root");

        await expect(readFile(sibling, "utf8")).resolves.toBe("keep me");
        expect(await pathExists(escaped)).toBe(false);
      } finally {
        await sandbox[Symbol.asyncDispose]();
      }
    });
  });

  test("dispose removes only the owned root, leaves the base and siblings, and is idempotent", async () => {
    await withTempBase(async (base) => {
      const sibling = path.join(base, "sibling-sentinel.txt");
      await writeFile(sibling, "still here");

      const sandbox = await createSandboxProviderLocal({ base, prefix: "dispose-" })();
      await sandbox.writeFiles([{ path: "nested/file.txt", content: "sandbox data" }]);

      expect(await pathExists(sandbox.root)).toBe(true);

      await sandbox[Symbol.asyncDispose]();
      await sandbox[Symbol.asyncDispose]();

      expect(await pathExists(sandbox.root)).toBe(false);
      expect(await pathExists(base)).toBe(true);
      await expect(readFile(sibling, "utf8")).resolves.toBe("still here");
    });
  });
});
