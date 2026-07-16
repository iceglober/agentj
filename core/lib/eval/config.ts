import z from "zod";
import { agentConfigSchema } from "../agent";
import { verdictEnum } from "./types";

/**
 * One experimental arm: a human label plus the agent config that IS the
 * variable under test. `id` is a display name only — two configs with the same
 * agent are the same arm, so the hash deliberately excludes `id`.
 */
export const runConfigSchema = z.object({
  id: z.string(), // human label, EXCLUDED from the hash
  agent: agentConfigSchema.prefault({}),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

/** Deterministic JSON: object keys sorted at every depth, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Stable 12-char id for the *meaningful* projection of a run config: the fields
 * that change agent behaviour. `id` is excluded; `temperature`/`topP` fold to
 * null when unset so "unset" and any future explicit value stay distinct.
 */
export function configHash(rc: RunConfig): string {
  const a = rc.agent;
  const projection = {
    name: a.name,
    role: a.role,
    rules: a.rules,
    provider: a.llm.provider,
    model: a.llm.model,
    temperature: a.llm.temperature ?? null,
    topP: a.llm.topP ?? null,
    editMode: a.tools.edit.mode,
    subagentConcurrency: a.tools.subagents.concurrency,
    prompt: { profile: a.prompt.profile, flags: a.prompt.flags ?? {} },
  };
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson(projection))
    .digest("hex")
    .slice(0, 12);
}

/** One graded trial, appended as a JSONL line to `${resultsDir}/${runId}.jsonl`. */
export const resultRowSchema = z.object({
  runId: z.string(),
  ts: z.string(),
  configHash: z.string(),
  configId: z.string(),
  promptVersion: z.string(),
  task: z.string(), // "id@version"
  tags: z.array(z.string()).default([]),
  seed: z.number().int(),
  verdict: verdictEnum,
  tokensIn: z.number(),
  tokensOut: z.number(),
  usd: z.number().nullable(),
  secs: z.number(),
  filesTouched: z.number(),
  subscores: z.record(z.string(), z.number()).default({}),
  fails: z.array(z.string()).default([]), // ids of failed required checks
  trajRef: z.string(),
});
export type ResultRow = z.infer<typeof resultRowSchema>;

/** The `eval.*` section of the root config. */
export const evalConfigSchema = z.object({
  resultsDir: z.string().default("core/eval/results"),
  trajDir: z.string().default("core/eval/traj"),
  tasksDir: z.string().default("core/eval/tasks"),
  configsDir: z.string().default("core/eval/configs"),
  concurrency: z.number().int().min(1).default(2),
  defaultSeeds: z.number().int().min(1).default(3),
  judge: z
    .object({ enabled: z.boolean().default(false), model: z.string().default("gpt-5.6-sol") })
    .prefault({}),
  /** $/Mtok by model id; usd is null for models not present. */
  prices: z.record(z.string(), z.object({ in: z.number(), out: z.number() })).default({}),
});
export type EvalConfig = z.infer<typeof evalConfigSchema>;

/** Dollar cost for a trial, or null if the model has no price entry. */
export function usdCost(
  prices: EvalConfig["prices"],
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | null {
  const p = prices[model];
  if (!p) return null;
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}
