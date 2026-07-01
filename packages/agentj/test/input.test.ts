import { describe, expect, test } from "bun:test";
import { SLASH_COMMANDS } from "../src/commands.ts";
import { completeCommand, renderLine } from "../src/input.ts";

const CMDS = SLASH_COMMANDS;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

describe("renderLine (highlight)", () => {
  test("plain (non-command) text is untouched", () => {
    expect(renderLine("fix the failing test", CMDS)).toBe("fix the failing test");
  });
  test("exact known command is bold-cyan; text is preserved under the ANSI", () => {
    const out = renderLine("/task", CMDS);
    expect(out).toContain(CYAN);
    expect(stripAnsi(out)).toBe("/task");
  });
  test("a valid prefix of a command highlights cyan (not red)", () => {
    const out = renderLine("/ta", CMDS);
    expect(out).toContain(CYAN);
    expect(out).not.toContain(RED);
  });
  test("an unknown /command is red", () => {
    const out = renderLine("/nope", CMDS);
    expect(out).toContain(RED);
  });
  test("only the command token is colored; the argument stays plain", () => {
    const out = renderLine("/task 2720 fix lint", CMDS);
    expect(out).toContain(" 2720 fix lint"); // remainder present verbatim (uncolored)
    expect(stripAnsi(out)).toBe("/task 2720 fix lint");
  });
});

describe("completeCommand (Tab)", () => {
  test("unique prefix completes to the full command + trailing space (takesArg)", () => {
    expect(completeCommand("/ta", CMDS)).toEqual({ line: "/task " });
  });
  test("a no-arg command completes without a trailing space", () => {
    expect(completeCommand("/ex", CMDS)).toEqual({ line: "/exit" }); // /exit takesArg=false → no trailing space
  });
  test("ambiguous stem extends to the longest common prefix", () => {
    // Both /exit and /quit... no shared prefix beyond "/"; "/" matches all 3 → LCP is "/", no progress → candidates.
    const r = completeCommand("/", CMDS);
    expect(r.line).toBe("/");
    expect(r.candidates?.map((c) => c.name).sort()).toEqual(["/exit", "/quit", "/task"]);
  });
  test("no match leaves the line unchanged", () => {
    expect(completeCommand("/zzz", CMDS)).toEqual({ line: "/zzz" });
  });
  test("does not complete once an argument has been started", () => {
    expect(completeCommand("/task 27", CMDS)).toEqual({ line: "/task 27" });
  });
  test("non-command input is left alone", () => {
    expect(completeCommand("hello", CMDS)).toEqual({ line: "hello" });
  });
});
