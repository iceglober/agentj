import { describe, expect, test } from "bun:test";
import { fuzzyFilter } from "./fuzzy";

describe("fuzzyFilter", () => {
  test("keeps source order empty and ranks exact, prefix, then subsequence matches", () => {
    const values = ["agent", "agents", "permissions", "configuration"];
    expect(fuzzyFilter("", values, (value) => value)).toEqual(values);
    expect(fuzzyFilter("agent", values, (value) => value)).toEqual(["agent", "agents"]);
    expect(fuzzyFilter("agt", values, (value) => value)).toEqual(["agent", "agents"]);
  });
});
