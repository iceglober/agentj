// Headless runner — v1's entry into real work. Owns the agent loop on the Vercel AI SDK
// (streamText drives the multi-step tool cycle), streams to the terminal, and writes one
// Ledger receipt per task. No SSE, no sandbox — that's P2/P0.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { streamText, type LanguageModelV1 } from "ai";
import type { Receipt, Tier } from "coder-core";
import { costOf, resolveModel } from "./agent/models.ts";
import { CHARTER } from "./agent/prompt.ts";
import { makeTools } from "./agent/tools.ts";
import { Ledger } from "./ledger/index.ts";
import { OUTPUT_CONTRACT } from "./succinctness/index.ts";

export interface RunOnceOptions {
  task: string;
  root: string;
  tier?: Tier;
  modelId?: string;
  /** Injected model for tests; bypasses API-key/provider resolution. */
  model?: LanguageModelV1;
  signal?: AbortSignal;
}

export interface RunOnceResult {
  ok: boolean;
  finishReason?: string;
  receipt?: Receipt;
  error?: string;
}

const MAX_STEPS = 25;

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function previewArgs(args: unknown): string {
  const s = (() => {
    try {
      return JSON.stringify(args) ?? "";
    } catch {
      return "";
    }
  })();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const tier: Tier = opts.tier ?? "mid";

  let model: LanguageModelV1;
  let modelId: string;
  if (opts.model) {
    model = opts.model;
    modelId = opts.modelId ?? "mock";
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
    }
    const resolved = resolveModel({ tier, modelId: opts.modelId });
    model = resolved.model;
    modelId = resolved.modelId;
  }

  await mkdir(join(opts.root, ".coder"), { recursive: true });
  const ledger = new Ledger(join(opts.root, ".coder", "ledger.jsonl"));

  const system = `${CHARTER}\n\n${OUTPUT_CONTRACT}`;
  const tools = makeTools({ root: opts.root, signal: opts.signal });
  const startedAt = new Date().toISOString();

  const result = streamText({
    model,
    system,
    prompt: opts.task,
    tools,
    maxSteps: MAX_STEPS,
    abortSignal: opts.signal,
  });

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.textDelta);
          break;
        case "tool-call":
          process.stdout.write(`\n· ${part.toolName}(${previewArgs(part.args)})\n`);
          break;
        case "error":
          process.stdout.write(`\n[error] ${asMessage(part.error)}\n`);
          break;
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      process.stdout.write("\n[aborted]\n");
      return { ok: false, error: "aborted" };
    }
    const msg = asMessage(err);
    process.stdout.write(`\n[model error] ${msg}\n`);
    return { ok: false, error: msg };
  }

  if (opts.signal?.aborted) {
    process.stdout.write("\n[aborted]\n");
    return { ok: false, error: "aborted" };
  }

  const usage = await result.usage;
  const finishReason = await result.finishReason;
  const costUsd = costOf(modelId, usage);

  const receipt: Receipt = {
    id: crypto.randomUUID(),
    taskClass: "free-text",
    tier,
    opHit: false,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    costUsd,
    tokensAvoided: 0,
    accuracy: { kind: "unverified" },
    startedAt,
    endedAt: new Date().toISOString(),
  };
  await ledger.record(receipt);

  process.stdout.write(
    `\n— ${modelId} · in ${usage.promptTokens} / out ${usage.completionTokens} tok · $${costUsd.toFixed(4)} · ${finishReason}\n`,
  );
  return { ok: true, finishReason, receipt };
}
