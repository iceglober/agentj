import { describe, expect, test } from "bun:test";

import { truncateWithNotice } from "./truncation";

describe("truncateWithNotice", () => {
  test("reserves room for an exact omitted-character notice", () => {
    expect(truncateWithNotice("abcdefghijklmnopqrstuvwxyz", 20)).toBe("abc [trunc 23 chars]");
    expect(Array.from(truncateWithNotice("🙂".repeat(30), 20))).toHaveLength(20);
    expect(truncateWithNotice("🙂".repeat(30), 20)).toBe("🙂🙂🙂 [trunc 27 chars]");
  });

  test("preserves untruncated and multiline text", () => {
    expect(truncateWithNotice("alpha\nbeta", 20)).toBe("alpha\nbeta");
    expect(truncateWithNotice(`${"x".repeat(30)}\ntail`, 24)).toEndWith("[trunc 28 chars]");
  });
});
