export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reportedUsd: number | null;
}

const empty = (): NormalizedUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reportedUsd: null,
});

export const parseClaudeUsage = (text: string): NormalizedUsage => {
  try {
    const value = JSON.parse(text) as {
      modelUsage?: Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          costUSD?: number;
        }
      >;
      total_cost_usd?: number;
    };
    const rows = Object.values(value.modelUsage ?? {});
    return {
      inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      cacheReadTokens: rows.reduce((sum, row) => sum + (row.cacheReadInputTokens ?? 0), 0),
      reportedUsd:
        value.total_cost_usd ?? rows.reduce((sum, row) => sum + (row.costUSD ?? 0), 0) ?? null,
    };
  } catch {
    return empty();
  }
};

export const parseCodexUsage = (text: string): NormalizedUsage => {
  let usage: Record<string, number> | undefined;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; usage?: Record<string, number> };
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {}
  }
  return usage
    ? {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cached_input_tokens ?? 0,
        reportedUsd: null,
      }
    : empty();
};

export const parseOpenCodeUsage = (text: string): NormalizedUsage => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reportedUsd = 0;
  let found = false;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        part?: {
          tokens?: { input?: number; output?: number; cache?: { read?: number } };
          cost?: number;
        };
      };
      if (event.type !== "step_finish" || !event.part?.tokens) continue;
      found = true;
      inputTokens += event.part.tokens.input ?? 0;
      outputTokens += event.part.tokens.output ?? 0;
      cacheReadTokens += event.part.tokens.cache?.read ?? 0;
      reportedUsd += event.part.cost ?? 0;
    } catch {}
  }
  return found ? { inputTokens, outputTokens, cacheReadTokens, reportedUsd } : empty();
};

export const estimatedUsd = (
  usage: NormalizedUsage,
  price: { input: number; output: number; cacheRead?: number },
): number =>
  ((usage.inputTokens - usage.cacheReadTokens) * price.input +
    usage.cacheReadTokens * (price.cacheRead ?? price.input) +
    usage.outputTokens * price.output) /
  1_000_000;
