import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "../src/tools.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agentj-tools-"));
}

/** Tools return strings; call execute directly. */
async function call(tool: any, args: unknown): Promise<string> {
  return (await tool.execute(args, {})) as string;
}

describe("read_file", () => {
  test("reads with line numbers", async () => {
    const root = scratch();
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const tools = makeTools({ root });
    const out = await call(tools.read_file, { path: "a.txt" });
    expect(out).toContain("1\tone");
    expect(out).toContain("3\tthree");
  });

  test("missing file is a message, not a throw", async () => {
    const tools = makeTools({ root: scratch() });
    expect(await call(tools.read_file, { path: "nope.txt" })).toContain("file not found");
  });

  test("rejects a path escaping the root", async () => {
    const tools = makeTools({ root: scratch() });
    expect(await call(tools.read_file, { path: "../../../etc/passwd" })).toContain("error:");
  });
});

describe("write_file + edit_file", () => {
  test("write then edit a unique string", async () => {
    const root = scratch();
    const tools = makeTools({ root });
    expect(await call(tools.write_file, { path: "src/x.ts", content: "const a = 1;\n" })).toContain("wrote");
    expect(await call(tools.edit_file, { path: "src/x.ts", old_string: "const a = 1;", new_string: "const a = 2;" })).toContain("edited");
    expect(await Bun.file(join(root, "src/x.ts")).text()).toBe("const a = 2;\n");
  });

  test("edit fails when old_string is not unique", async () => {
    const root = scratch();
    writeFileSync(join(root, "d.txt"), "x\nx\n");
    const tools = makeTools({ root });
    expect(await call(tools.edit_file, { path: "d.txt", old_string: "x", new_string: "y" })).toContain("not unique");
  });

  test("edit fails when old_string is absent", async () => {
    const root = scratch();
    writeFileSync(join(root, "d.txt"), "hello\n");
    const tools = makeTools({ root });
    expect(await call(tools.edit_file, { path: "d.txt", old_string: "absent", new_string: "y" })).toContain("not found");
  });
});

describe("bash", () => {
  test("runs a command and reports the exit code", async () => {
    const tools = makeTools({ root: scratch() });
    const out = await call(tools.bash, { command: "echo hi" });
    expect(out).toContain("hi");
    expect(out).toContain("[exit 0]");
  });
});
