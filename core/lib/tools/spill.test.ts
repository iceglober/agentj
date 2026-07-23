import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateWithSpill } from "../truncation";
import { createSpillSink } from "./spill";

describe("createSpillSink", () => {
  test("writes sequenced files under the dir and removes them on close", () => {
    const sink = createSpillSink(join(tmpdir(), `glorious-spill-test-${process.pid}`));
    try {
      const first = sink.write("bash-stdout", "abc");
      const second = sink.write("mcp", "def");
      expect(first).toBe(join(sink.dir, "0001-bash-stdout.txt"));
      expect(second).toBe(join(sink.dir, "0002-mcp.txt"));
      expect(readFileSync(first as string, "utf8")).toBe("abc");
    } finally {
      sink.close();
    }
    expect(existsSync(sink.dir)).toBe(false);
  });

  test("sanitizes hostile labels into safe file names", () => {
    const sink = createSpillSink(join(tmpdir(), `glorious-spill-test2-${process.pid}`));
    try {
      const path = sink.write("../../etc passwd!", "x");
      expect(path).toBe(join(sink.dir, "0001-_etc_passwd_.txt"));
    } finally {
      sink.close();
    }
  });
});

describe("truncateWithSpill", () => {
  test("under-cap values pass through without spilling", () => {
    let called = 0;
    const result = truncateWithSpill("short", 100, () => {
      called += 1;
      return "/never";
    });
    expect(result).toBe("short");
    expect(called).toBe(0);
  });

  test("over-cap values spill and the bounded result stays within the cap", () => {
    const result = truncateWithSpill("x".repeat(500), 200, () => "/spill/0001-output.txt");
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain("[trunc ");
    expect(result).toContain("[full output: /spill/0001-output.txt");
  });

  test("without a writer it matches plain truncation semantics", () => {
    const result = truncateWithSpill("x".repeat(500), 200);
    expect(result).toHaveLength(200);
    expect(result).toEndWith("[trunc 318 chars]");
  });
});
