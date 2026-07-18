import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostExecutionEnvironment } from "./host-adapter";

test("host execution uses cwd and never owns or removes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-host-workspace-"));
  try {
    await writeFile(path.join(root, "source.txt"), "before");
    const environment = await createHostExecutionEnvironment(root);
    expect((await environment.executeCommand("pwd")).stdout.trim()).toBe(await realpath(root));
    await environment.writeFiles([{ path: "nested/result.txt", content: "after" }]);
    expect(await environment.readFile("nested/result.txt")).toBe("after");
    await environment[Symbol.asyncDispose]();
    expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe("before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kills commands that exceed the timeout and reports exit 124", async () => {
  const environment = await createHostExecutionEnvironment(process.cwd(), {
    commandTimeoutMs: 200,
  });
  const started = Date.now();
  const result = await environment.executeCommand("sleep 30");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("timed out");
});

test("kills the whole process group: a compound command's child cannot outlive the kill", async () => {
  const environment = await createHostExecutionEnvironment(process.cwd(), {
    commandTimeoutMs: 200,
  });
  const started = Date.now();
  // `true && sleep` forks sleep as a child of bash; killing only the parent
  // would leave sleep holding the stdio pipes open until it exits on its own.
  const result = await environment.executeCommand("true && sleep 30");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.exitCode).toBe(124);
});

test("an abort signal kills the running command and reports exit 130", async () => {
  const environment = await createHostExecutionEnvironment(process.cwd());
  const abort = new AbortController();
  const started = Date.now();
  const pending = environment.executeCommand("sleep 30", { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  const result = await pending;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.exitCode).toBe(130);
  expect(result.stderr).toContain("interrupted");
});

test("an already-aborted signal kills the command without waiting", async () => {
  const environment = await createHostExecutionEnvironment(process.cwd());
  const abort = new AbortController();
  abort.abort();
  const started = Date.now();
  const result = await environment.executeCommand("sleep 30", { signal: abort.signal });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.exitCode).toBe(130);
});
