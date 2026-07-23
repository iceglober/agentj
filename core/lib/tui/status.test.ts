import { describe, expect, test } from "bun:test";
import { composeStatusSection, formatClock, formatVuMeter } from "./status";
import { displayWidth } from "./terminal-editor";

const base = {
  sessionId: "204ed50c",
  version: "0.1.0-next.32",
  root: "~/repos/glorious",
  model: "azure/gpt-5.6-sol",
  mode: "plan" as const,
  spinnerFrame: 0,
  usage: { in: 12_400, out: 3_100, ctx: 8_700 },
  sessionStartedAt: 0,
  jobs: [],
  now: 74_000,
};

describe("composeStatusSection", () => {
  test("splits the footer into an info line and a controls line", () => {
    expect(composeStatusSection(base, 120)).toEqual([
      "~/repos/glorious · azure/gpt-5.6-sol · ctx 8.7k",
      "Tab mode · / commands",
    ]);
  });

  test("shortens location before dropping it", () => {
    const lines = composeStatusSection(
      {
        ...base,
        root: "~/.glrs/worktrees/glorious/wt-260718-231658-7yr",
      },
      60,
    );
    expect(lines[0]).toContain("~/.glrs/w");
    expect(lines[0]).toContain("…");
    expect(lines[0]).toContain("azure/gpt-5.6-sol · ctx 8.7k");
    expect(lines[1]).toBe("Tab mode · / commands");
    expect(lines.every((line) => displayWidth(line) <= 60)).toBe(true);
  });

  test("degrades the info line to model, then bare context", () => {
    // Full width no longer needs to reserve room for the controls line.
    expect(composeStatusSection(base, 38)[0]).toBe("azure/gpt-5.6-sol · ctx 8.7k");
    expect(composeStatusSection(base, 38)[1]).toBe("Tab mode · / commands");
    expect(composeStatusSection(base, 20)[0]).toBe("ctx 8.7k");
  });

  test("shows context against the configured soft limit without a warning glyph", () => {
    expect(composeStatusSection({ ...base, contextSoftLimit: 10_000 }, 120)[0]).toContain(
      "ctx 8.7k/10.0k",
    );
    expect(composeStatusSection({ ...base, contextSoftLimit: 8_000 }, 120)[0]).toContain(
      "ctx 8.7k/8.0k",
    );
  });

  test("fits Unicode roots and job prompts without screen clipping", () => {
    const width = 35;
    const lines = composeStatusSection(
      {
        ...base,
        root: "~/界/very/deep/project/🙂",
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
    expect(lines.at(-1)).toContain("job-with");
  });

  test("preserves standard-width job rows after the info and controls lines", () => {
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
      "  ▏ [j1] build: Run the test suite  24s",
      "  ▏ [j2] plan: Investigate the failure  14s",
    ]);
  });
});

describe("formatVuMeter", () => {
  const BLOCKS = new Set([..."▁▂▃▄▅▆▇█"]);

  test("renders one bobbing block per bar, deterministic in the frame", () => {
    expect([...formatVuMeter(0)]).toHaveLength(5);
    expect([...formatVuMeter(0, 3)]).toHaveLength(3);
    expect([...formatVuMeter(7)].every((glyph) => BLOCKS.has(glyph))).toBe(true);
    expect(formatVuMeter(4)).toBe(formatVuMeter(4)); // same frame → same bars
  });

  test("animates: the bars change as the frame advances", () => {
    const frames = new Set([0, 1, 2, 3, 4, 5].map((frame) => formatVuMeter(frame)));
    expect(frames.size).toBeGreaterThan(1);
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
