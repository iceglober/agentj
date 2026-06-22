import { describe, expect, test } from "bun:test";
import { isInsideWorktree, mergeRegistries, Routes } from "../src/index.ts";

describe("worktree path guard", () => {
  test("accepts paths inside the root", () => {
    expect(isInsideWorktree("/wt/repo", "/wt/repo/src/a.ts")).toBe(true);
    expect(isInsideWorktree("/wt/repo", "/wt/repo")).toBe(true);
  });

  test("rejects escapes", () => {
    expect(isInsideWorktree("/wt/repo", "/wt/repo-evil/x")).toBe(false);
    expect(isInsideWorktree("/wt/repo", "/etc/passwd")).toBe(false);
  });
});

describe("registry precedence", () => {
  test("project entries shadow global on name collision", () => {
    const reg = mergeRegistries(
      [{ name: "pr_status", kind: "capability", scope: "project", hits: 3, tokensAvoided: 100 }],
      [{ name: "pr_status", kind: "capability", scope: "global", hits: 9, tokensAvoided: 999 }],
    );
    expect(reg.resolve("pr_status")?.scope).toBe("project");
    expect(reg.entries).toHaveLength(1);
  });
});

describe("protocol routes", () => {
  test("build session-scoped paths", () => {
    expect(Routes.events("abc")).toBe("/session/abc/events");
    expect(Routes.permission("abc", "p1")).toBe("/session/abc/permission/p1");
  });
});
