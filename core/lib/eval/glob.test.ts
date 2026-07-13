import { describe, expect, test } from "bun:test";
import { globMatch } from "./glob";

describe("globMatch", () => {
  test("** crosses any depth", () => {
    expect(globMatch("**/*.py", "a/b/c.py")).toBe(true);
    expect(globMatch("**/*.py", "c.py")).toBe(true);
    expect(globMatch("**", "a/b/c")).toBe(true);
  });

  test("* stays within one segment", () => {
    expect(globMatch("*.py", "b.py")).toBe(true);
    expect(globMatch("*.py", "a/b.py")).toBe(false);
  });

  test("trailing /** matches the directory itself and its contents", () => {
    expect(globMatch("src/**", "src")).toBe(true);
    expect(globMatch("src/**", "src/main.ts")).toBe(true);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/**", "srcx")).toBe(false);
    expect(globMatch("src/**", "other/main.ts")).toBe(false);
  });

  test("? matches exactly one non-slash char", () => {
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("a?c", "a/c")).toBe(false);
  });

  test("dots are literal, not wildcards", () => {
    expect(globMatch("a.py", "axpy")).toBe(false);
    expect(globMatch("a.py", "a.py")).toBe(true);
  });

  test("middle ** matches zero or more segments", () => {
    expect(globMatch("a/**/b", "a/b")).toBe(true);
    expect(globMatch("a/**/b", "a/x/b")).toBe(true);
    expect(globMatch("a/**/b", "a/x/y/b")).toBe(true);
  });
});
