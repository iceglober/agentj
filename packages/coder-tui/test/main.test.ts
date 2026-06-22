import { describe, expect, test } from "bun:test";
import { main } from "../src/index.ts";

describe("tui entry", () => {
  test("--version prints a version and does not throw", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => lines.push(String(msg));
    try {
      await main(["--version"]);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toMatch(/\d+\.\d+\.\d+/);
  });

  test("--help mentions usage", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => lines.push(String(msg));
    try {
      await main(["--help"]);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain("USAGE");
  });
});
