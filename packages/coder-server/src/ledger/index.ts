// Ledger — one receipt per task. Local, file-based, crash-safe (append-only JSONL,
// state derivable by replay — PLAN N4). Source of truth for the status bar *and* the
// Distiller. Records the cost/token trio plus tokens-avoided, steps-saved, det-hit,
// verbosity ratio, verifyPassed (PLAN R10).
import { appendEvent, readEvents, type Receipt } from "coder-core";

export class Ledger {
  /** @param path JSONL file under the worktree (e.g. `.coder/ledger.jsonl`). */
  constructor(private readonly path: string) {}

  async record(receipt: Receipt): Promise<void> {
    await appendEvent(this.path, receipt.endedAt, receipt);
  }

  async all(): Promise<Receipt[]> {
    const entries = await readEvents<Receipt>(this.path);
    return entries.map((e) => e.data);
  }

  /** Rollup for the status bar: totals across all receipts. */
  async rollup(): Promise<LedgerRollup> {
    const receipts = await this.all();
    const acc: LedgerRollup = {
      tasks: receipts.length,
      costUsd: 0,
      tokensAvoided: 0,
      inferenceStepsSaved: 0,
      detHits: 0,
    };
    for (const r of receipts) {
      acc.costUsd += r.costUsd;
      acc.tokensAvoided += r.tokensAvoided;
      acc.inferenceStepsSaved += r.inferenceStepsSaved;
      if (r.detHit) acc.detHits += 1;
    }
    return acc;
  }
}

export interface LedgerRollup {
  tasks: number;
  costUsd: number;
  tokensAvoided: number;
  inferenceStepsSaved: number;
  detHits: number;
}
