import { describe, expect, test } from "bun:test";
import { composeStatusSection, composeThinkingLine, formatClock } from "./status";
import { displayWidth } from "./terminal-editor";

const base = {
  sessionId: "204ed50c",
  version: "0.1.0-next.32",
  root: "~/repos/agentj",
  model: "azure/gpt-5.6-sol",
  mode: "plan" as const,
  spinnerFrame: 0,
  usage: { in: 12_400, out: 3_100, ctx: 8_700 },
  sessionStartedAt: 0,
  jobs: [],
  now: 74_000,
};

describe("composeThinkingLine", () => {
  const state = {
    thinking: true,
    interruptRequested: false,
    spinnerFrame: 0,
    turnStartedAt: 62_000,
    now: 74_000,
  };

  test("preserves the standard-width line and shortens cleanly when needed", () => {
    expect(composeThinkingLine(state, 80)).toBe("◐ thinking 12s (esc)");
    expect(composeThinkingLine(state, 12)).toBe("◐ thinking …");
  });

  test("omits inactive thinking", () => {
    expect(
      composeThinkingLine(
        { thinking: false, interruptRequested: false, spinnerFrame: 0, turnStartedAt: null },
        80,
      ),
    ).toBeNull();
  });
});

describe("composeStatusSection", () => {
  test("keeps the full standard-width identity and metrics layout", () => {
    expect(composeStatusSection(base, 120)).toEqual([
      "204ed50c · azure/gpt-5.6-sol · plan (tab↕)                                        in 12.4k ▸ out 3.1k · ctx 8.7k · 1m14s",
      "~/repos/agentj                                                                                          aj 0.1.0-next.32",
    ]);
    expect(composeStatusSection(base, 140)).toEqual([
      "204ed50c · azure/gpt-5.6-sol · plan (tab↕)                                                            in 12.4k ▸ out 3.1k · ctx 8.7k · 1m14s",
      "~/repos/agentj                                                                                                              aj 0.1.0-next.32",
    ]);
  });

  test("pins the aj version to the right and shortens the root first", () => {
    const lines = composeStatusSection({ ...base, root: "~/repos/very/deep/project/root" }, 35);
    expect(lines[1]).toBe("~/repo…oject/root  aj 0.1.0-next.32");
  });

  test("keeps session, labeled metrics, and million-scale tokens at 79 columns", () => {
    const lines = composeStatusSection(
      {
        ...base,
        sessionId: "4316bd7c",
        version: "0.1.0-next.39",
        root: "~/.glrs/worktrees/agentj/wt-260718-231658-7yr",
        usage: { in: 1_952_300, out: 24_600, ctx: 60_000 },
        now: 1_382_000,
      },
      79,
    );

    expect(lines[0]).toContain("4316bd7c · plan (tab↕)");
    expect(lines[0]).toContain("in 2.0m ▸ out 24.6k · ctx 60.0k · 23m2s");
    expect(lines[0]).not.toContain("azure/gpt-5.6-sol");
    expect(lines.every((line) => displayWidth(line) <= 79)).toBe(true);
  });

  test("degrades from labels to compact metrics before the essential fallback", () => {
    const compact = composeStatusSection(base, 55)[0] ?? "";
    const essential = composeStatusSection(base, 30)[0] ?? "";

    expect(compact).toContain("204ed50c · plan (tab↕)");
    expect(compact).toContain("12.4k▸3.1k·8.7k·1m14s");
    expect(essential).toContain("plan (tab↕)");
    expect(essential).toContain("ctx 8.7k · 1m14s");
  });

  test("shows cache reads in the full form and drops them in compact form", () => {
    const wide =
      composeStatusSection({ ...base, usage: { ...base.usage, cacheRead: 8_030 } }, 120)[0] ?? "";
    const narrow =
      composeStatusSection({ ...base, usage: { ...base.usage, cacheRead: 8_030 } }, 66)[0] ?? "";

    expect(wide).toContain("in 12.4k · cached 8.0k(65%) ▸ out 3.1k");
    expect(narrow).not.toContain("cached");
  });

  test("flags context at the configured soft limit", () => {
    expect(composeStatusSection({ ...base, contextSoftLimit: 10_000 }, 120)[0]).toContain(
      "ctx 8.7k ·",
    );
    expect(composeStatusSection({ ...base, contextSoftLimit: 8_000 }, 120)[0]).toContain(
      "ctx 8.7k!",
    );
  });

  test("fits Unicode roots, versions, and job prompts without screen clipping", () => {
    const width = 35;
    const lines = composeStatusSection(
      {
        ...base,
        root: "~/界/very/deep/project/🙂",
        version: "0.1.0-next.32🙂",
        jobs: [
          {
            id: "job-with-a-long-id",
            mode: "build",
            prompt: "Investigate a 🙂 Unicode prompt that exceeds the available terminal width",
            startedAt: 50_000,
          },
        ],
      },
      width,
    );

    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    expect(lines[2]).toContain("job-with");
  });

  test("preserves standard-width job rows", () => {
    const lines = composeStatusSection(
      {
        ...base,
        jobs: [
          { id: "j1", mode: "build", prompt: "Run the test suite", startedAt: 50_000 },
          { id: "j2", mode: "plan", prompt: "Investigate the failure", startedAt: 60_000 },
        ],
      },
      90,
    );

    expect(lines.slice(2)).toEqual([
      "  ◐ [j1] build: Run the test suite  24s",
      "  ◐ [j2] plan: Investigate the failure  14s",
    ]);
  });
});

describe("formatClock", () => {
  test("scales units with elapsed time", () => {
    expect(formatClock(9_000)).toBe("9s");
    expect(formatClock(74_000)).toBe("1m14s");
    expect(formatClock(3.5 * 3_600_000)).toBe("3h30m");
    expect(formatClock(30 * 3_600_000)).toBe("1d6h0m");
  });
});
