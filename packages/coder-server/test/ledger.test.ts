import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Receipt } from "coder-core";
import { Ledger } from "../src/ledger/index.ts";

function receipt(id: string): Receipt {
  const at = new Date().toISOString();
  return {
    id,
    taskClass: "free-text",
    tier: "mid",
    opHit: false,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.001,
    tokensAvoided: 0,
    effort: { turns: 1, toolCalls: 0, filesRead: 0, filesWritten: 0, repeatedCalls: 0, timeouts: 0, toolMs: 0 },
    verdict: "unknown",
    startedAt: at,
    endedAt: at,
  };
}

describe("ledger verdicts (the borrowed human sign-off)", () => {
  test("a sign-off folds onto the matching receipt; others stay unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coder-ledger-"));
    try {
      const ledger = new Ledger(join(dir, ".coder", "ledger.jsonl"));
      await ledger.record(receipt("r1"));
      await ledger.record(receipt("r2"));

      // Before any sign-off, every receipt is "unknown" — never faked.
      expect((await ledger.all()).map((r) => r.verdict)).toEqual(["unknown", "unknown"]);

      await ledger.recordVerdict("r1", "accepted");
      const byId = new Map((await ledger.all()).map((r) => [r.id, r.verdict]));
      expect(byId.get("r1")).toBe("accepted");
      expect(byId.get("r2")).toBe("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollup reports verdict mix + average effort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coder-ledger-"));
    try {
      const ledger = new Ledger(join(dir, ".coder", "ledger.jsonl"));
      const a = receipt("a");
      a.effort = { turns: 2, toolCalls: 4, filesRead: 0, filesWritten: 0, repeatedCalls: 0, timeouts: 0, toolMs: 0 };
      const b = receipt("b");
      b.effort = { turns: 4, toolCalls: 0, filesRead: 0, filesWritten: 0, repeatedCalls: 0, timeouts: 0, toolMs: 0 };
      await ledger.record(a);
      await ledger.record(b);
      await ledger.recordVerdict("a", "accepted");

      const r = await ledger.rollup();
      expect(r.tasks).toBe(2);
      expect(r.verdicts).toEqual({ accepted: 1, rejected: 0, abandoned: 0, unknown: 1 });
      expect(r.avgTurns).toBe(3); // (2 + 4) / 2
      expect(r.avgToolCalls).toBe(2); // (4 + 0) / 2
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("last sign-off wins (you can change your mind)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coder-ledger-"));
    try {
      const ledger = new Ledger(join(dir, ".coder", "ledger.jsonl"));
      await ledger.record(receipt("r1"));
      await ledger.recordVerdict("r1", "accepted");
      await ledger.recordVerdict("r1", "rejected");
      expect((await ledger.all())[0].verdict).toBe("rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
