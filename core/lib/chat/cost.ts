import type { ChatLogRecord } from "../session/log";

export type UsageRecord = Extract<ChatLogRecord, { type: "usage" }>;

/** Azure's long-context price tier starts past this many input tokens per
 *  request; /cost surfaces the count so the softLimit lever stays honest. */
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;

export interface CostPrice {
  in: number;
  out: number;
}

interface CostTotals {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  longContextRequests: number;
}

export interface CostReportRow extends CostTotals {
  provider: string;
  model: string;
  usd: number | null;
}

const emptyTotals = (): CostTotals => ({
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  longContextRequests: 0,
});

/** Aggregate persisted foreground-turn usage by the provider/model that served it. */
export function accumulateCostRows(
  records: readonly UsageRecord[],
  prices: Readonly<Record<string, CostPrice>>,
): CostReportRow[] {
  const rows = new Map<string, CostReportRow>();
  for (const record of records) {
    const key = `${record.provider}\u0000${record.model}`;
    let row = rows.get(key);
    if (!row) {
      row = { provider: record.provider, model: record.model, ...emptyTotals(), usd: null };
      rows.set(key, row);
    }
    row.inputTokens += record.usage.inputTokens;
    row.cacheReadInputTokens += record.usage.cacheReadInputTokens ?? 0;
    row.cacheWriteInputTokens += record.usage.cacheWriteInputTokens ?? 0;
    row.outputTokens += record.usage.outputTokens;
    row.longContextRequests += record.usage.longContextRequests;
  }
  return [...rows.values()]
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
    )
    .map((row) => {
      const price = prices[row.model];
      return {
        ...row,
        usd: price
          ? (row.inputTokens / 1e6) * price.in + (row.outputTokens / 1e6) * price.out
          : null,
      };
    });
}

const formatTokens = (tokens: number): string => new Intl.NumberFormat("en-US").format(tokens);
const formatUsd = (usd: number | null): string => (usd === null ? "$ n/a" : `$${usd.toFixed(4)}`);

/** Terminal-native report. Prices are supplied by the composition root, never read here. */
export function formatCostReport(
  records: readonly UsageRecord[],
  prices: Readonly<Record<string, CostPrice>>,
): string {
  const rows = accumulateCostRows(records, prices);
  if (rows.length === 0) return "No foreground-turn usage recorded yet.";

  const header =
    "provider/model | input (no-cache / cache-read / cache-write) | output | long-context | USD";
  const lines = [header];
  const totals = emptyTotals();
  let totalUsd = 0;
  let hasUnpriced = false;
  let hasCacheTokens = false;
  for (const row of rows) {
    const noCacheTokens = Math.max(0, row.inputTokens - row.cacheReadInputTokens);
    lines.push(
      `${row.provider}/${row.model} | ${formatTokens(row.inputTokens)} (${formatTokens(noCacheTokens)} / ${formatTokens(row.cacheReadInputTokens)} / ${formatTokens(row.cacheWriteInputTokens)}) | ${formatTokens(row.outputTokens)} | ${formatTokens(row.longContextRequests)} | ${formatUsd(row.usd)}`,
    );
    totals.inputTokens += row.inputTokens;
    totals.cacheReadInputTokens += row.cacheReadInputTokens;
    totals.cacheWriteInputTokens += row.cacheWriteInputTokens;
    totals.outputTokens += row.outputTokens;
    totals.longContextRequests += row.longContextRequests;
    if (row.usd === null) hasUnpriced = true;
    else totalUsd += row.usd;
    hasCacheTokens ||= row.cacheReadInputTokens > 0 || row.cacheWriteInputTokens > 0;
  }
  const totalNoCacheTokens = Math.max(0, totals.inputTokens - totals.cacheReadInputTokens);
  lines.push(
    `Total | ${formatTokens(totals.inputTokens)} (${formatTokens(totalNoCacheTokens)} / ${formatTokens(totals.cacheReadInputTokens)} / ${formatTokens(totals.cacheWriteInputTokens)}) | ${formatTokens(totals.outputTokens)} | ${formatTokens(totals.longContextRequests)} | ${hasUnpriced ? "$ n/a" : formatUsd(totalUsd)}`,
  );
  if (hasCacheTokens) lines.push("Cache reads are priced at the input rate.");
  return lines.join("\n");
}
