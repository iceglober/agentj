import { describe, expect, test } from "bun:test";
import { tuiConfigSchema } from "./config";

describe("tuiConfigSchema", () => {
  test("defaults the renderer to opentui", () => {
    expect(tuiConfigSchema.parse({})).toEqual({ renderer: "opentui" });
  });
  test("accepts the ansi renderer", () => {
    expect(tuiConfigSchema.parse({ renderer: "ansi" })).toEqual({ renderer: "ansi" });
  });
  test("rejects an unknown renderer", () => {
    expect(tuiConfigSchema.safeParse({ renderer: "fancy" }).success).toBe(false);
  });
});
