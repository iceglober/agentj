import { describe, expect, test } from "bun:test";
import type { CompletionReport } from "../report";
import type { UiLine, UiSpan, UiTone } from "./styles";
import {
  renderCompletionReportBlock,
  renderDagLine,
  renderToolRow,
  renderTranscriptItem,
  toTranscriptItem,
  type ToolOutcome,
  type TranscriptItem,
} from "./transcript-item";

const WIDTH = 80;

/** Flatten a block's spans so tests can assert on plain span shapes. */
const spans = (line: UiLine): readonly UiSpan[] => line;

describe("renderTranscriptItem spacing + block per kind", () => {
  const cases: Array<{ item: TranscriptItem; spacing: "none" | "turn" }> = [
    { item: { kind: "user", text: "hi" }, spacing: "turn" },
    { item: { kind: "assistant", body: "done." }, spacing: "turn" },
    { item: { kind: "empty" }, spacing: "turn" },
    { item: { kind: "tool", row: { tool: "read", detail: "x", outcome: "ok" } }, spacing: "none" },
    { item: { kind: "error", text: "error: boom" }, spacing: "none" },
    { item: { kind: "notice", text: "hello" }, spacing: "none" },
    { item: { kind: "command", text: "Command: help" }, spacing: "none" },
    { item: { kind: "job", text: "[j1] started", status: "started" }, spacing: "none" },
    { item: { kind: "reflection", text: "second thoughts" }, spacing: "turn" },
  ];

  for (const { item, spacing } of cases) {
    test(`${item.kind} → spacing ${spacing}`, () => {
      const rendered = renderTranscriptItem(item, WIDTH);
      expect(rendered.spacing).toBe(spacing);
      expect(rendered.block.length).toBeGreaterThan(0);
    });
  }

  test("assistant with a completion report renders toned status + headers", () => {
    const report: CompletionReport = {
      status: "done",
      summary: "shipped",
      changes: ["a"],
      validation: [],
      nextSteps: [],
      openQuestions: [],
    };
    const { block, spacing } = renderTranscriptItem({ kind: "assistant", body: "", report }, WIDTH);
    expect(spacing).toBe("turn");
    expect(block[0]).toEqual([{ text: "Done — shipped", tone: "success" }]);
  });

  test("empty response is a single muted notice line", () => {
    const { block } = renderTranscriptItem({ kind: "empty" }, WIDTH);
    expect(block).toEqual([
      [{ text: "(no response — the model returned nothing; try again)", tone: "muted" }],
    ]);
  });

  test("a toned notice colors every line; an untoned one stays plain", () => {
    expect(
      renderTranscriptItem({ kind: "notice", text: "a\nb", tone: "danger" }, WIDTH).block,
    ).toEqual([[{ text: "a", tone: "danger" }], [{ text: "b", tone: "danger" }]]);
    expect(renderTranscriptItem({ kind: "notice", text: "a" }, WIDTH).block).toEqual([
      [{ text: "a" }],
    ]);
  });

  test("a reflection event maps to a reflection item and renders muted wrapped lines", () => {
    expect(toTranscriptItem({ type: "reflection", text: "my second thoughts" })).toEqual({
      kind: "reflection",
      text: "my second thoughts",
    });
    const { block, spacing } = renderTranscriptItem(
      { kind: "reflection", text: "  a fairly long reflection line that has to wrap somewhere" },
      24,
    );
    expect(spacing).toBe("turn");
    expect(block.length).toBeGreaterThan(1);
    for (const line of block) {
      expect(line[0]?.tone).toBe("muted");
      expect(line[0]?.text.startsWith("  ")).toBe(true);
    }
  });

  test("a failed job tones its head line danger, leaving the body plain", () => {
    const { block } = renderTranscriptItem(
      { kind: "job", text: "[j1] Failed in 1s\nChild setup failed.", status: "failed" },
      WIDTH,
    );
    expect(block[0]).toEqual([{ text: "[j1] Failed in 1s", tone: "danger" }]);
    expect(block[1]).toEqual([{ text: "Child setup failed." }]);
  });
});

describe("renderToolRow — only the glyph carries tone", () => {
  const glyphs: Record<Exclude<ToolOutcome, "running">, { glyph: string; tone: UiTone }> = {
    ok: { glyph: "✓", tone: "success" },
    fail: { glyph: "✗", tone: "danger" },
    blocked: { glyph: "⊘", tone: "warning" },
  };

  for (const outcome of ["ok", "fail", "blocked"] as const) {
    test(`${outcome} row tones only the glyph`, () => {
      const [line] = renderToolRow(
        { tool: "read", detail: "src/x.ts", elapsedMs: 1_200, outcome },
        { live: false },
        WIDTH,
      );
      const list = spans(line);
      const glyphSpan = list.find((span) => span.text === glyphs[outcome].glyph);
      expect(glyphSpan?.tone).toBe(glyphs[outcome].tone);
      // The tool name is default weight, untoned.
      const toolSpan = list.find((span) => span.text === "read");
      expect(toolSpan?.tone).toBeUndefined();
      expect(toolSpan?.bold).toBeUndefined();
      // Detail and duration are muted — never the outcome tone.
      const detail = list.find((span) => span.text.includes("src/x.ts"));
      const duration = list.find((span) => span.text.includes("1.2s"));
      expect(detail?.tone).toBe("muted");
      expect(duration?.tone).toBe("muted");
      // No span other than the glyph carries the outcome tone.
      expect(list.filter((span) => span.tone === glyphs[outcome].tone)).toHaveLength(1);
    });
  }

  test("live rows use the accent spinner glyph", () => {
    const [line] = renderToolRow(
      { tool: "read", detail: "", outcome: "ok" },
      { live: true },
      WIDTH,
    );
    expect(spans(line).find((span) => span.text === "▌")?.tone).toBe("accent");
  });

  test("owned DAG rows freeze below the tool line, toned by glyph", () => {
    const block = renderToolRow(
      { tool: "run_subagents", detail: "3 tasks", outcome: "ok", dag: ["    ✓ Review done"] },
      { live: false },
      WIDTH,
    );
    expect(block).toHaveLength(2);
    expect(block[1]).toEqual([{ text: "    ✓ Review done", tone: "success" }]);
  });
});

describe("renderDagLine", () => {
  test("tones by leading glyph and preserves indentation", () => {
    expect(renderDagLine("    ✓ ok")).toEqual([{ text: "    ✓ ok", tone: "success" }]);
    expect(renderDagLine("  ✗ nope")).toEqual([{ text: "  ✗ nope", tone: "danger" }]);
    expect(renderDagLine("  · idle")).toEqual([{ text: "  · idle", tone: "muted" }]);
    expect(renderDagLine("  ↳ queued")).toEqual([{ text: "  ↳ queued", tone: "muted" }]);
    expect(renderDagLine("plain")).toEqual([{ text: "plain" }]);
  });

  test("upgrades a legacy 'x ' marker to '✗ ' and tones it danger", () => {
    expect(renderDagLine("    x failed task")).toEqual([
      { text: "    ✗ failed task", tone: "danger" },
    ]);
  });
});

describe("renderCompletionReportBlock", () => {
  const report: CompletionReport = {
    status: "failed",
    summary: "tests broke",
    changes: ["edited a.ts"],
    validation: [{ command: "bun test", outcome: "failed", evidence: "3 failing" }],
    nextSteps: ["fix a.ts"],
    openQuestions: ["retry?"],
  };

  test("tones the status line by status and uses bold+underline headers", () => {
    const block = renderCompletionReportBlock(report);
    expect(block[0]).toEqual([{ text: "Failed — tests broke", tone: "danger" }]);
    const headerLines = block.filter(
      (line) => line.length === 1 && line[0]?.bold && line[0]?.underline,
    );
    const headers = headerLines.map((line) => line[0]?.text);
    expect(headers).toEqual(["Changes", "Validation", "Next", "Open questions"]);
    // Section bodies are plain bullet lines, not raw prose.
    expect(block).toContainEqual([{ text: "- Failed — bun test: 3 failing" }]);
  });

  test("maps each status to its tone", () => {
    const tone = (status: CompletionReport["status"]): unknown =>
      renderCompletionReportBlock({ ...report, status })[0]?.[0]?.tone;
    expect(tone("done")).toBe("success");
    expect(tone("failed")).toBe("danger");
    expect(tone("blocked")).toBe("warning");
    expect(tone("in_progress")).toBe("accent");
  });
});
