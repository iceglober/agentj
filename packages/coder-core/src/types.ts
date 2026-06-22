// Shared domain types for coder. Pure data shapes — no runtime deps.
// These are the contracts every package agrees on; behavior lives in coder-server.

/** Model tiers, cheapest-first. The Router picks the cheapest capable tier. */
export type Tier = "cheap" | "fast" | "mid" | "deep";

/** Normalized succinctness setting → per-provider output controls (PLAN R13). */
export type Succinctness = "low" | "normal" | "high";

/**
 * A Capability: a deterministic, structured op callable by the agent (as a tool) and
 * by the user (via `/`). One typed answer, no model call (PLAN R1, N2). Stored as a
 * file under `.coder/capabilities/<name>`.
 */
export interface CapabilitySpec {
  name: string;
  /** One-line description used for relevance gating / `find_capability`. */
  description: string;
  /** JSON-schema-ish shape of the input args (kept structured, sensible defaults). */
  input?: Record<string, unknown>;
  /** Where this det came from — source receipts for replay (PLAN R6). */
  provenance?: Provenance;
}

/**
 * An Extractor: a deterministic parser that reduces noisy tool output (test/lint/
 * build/git) to structured signal *before* it hits context; raw spills to disk (R2).
 */
export interface ExtractorSpec {
  name: string;
  /** Which tool's output this extractor reduces (e.g. "bash:test"). */
  appliesTo: string;
  description: string;
  provenance?: Provenance;
}

/** Where a distilled det came from — receipts that justify it (PLAN R5/R6). */
export interface Provenance {
  /** Ledger receipt ids the Distiller mined to synthesize this det. */
  receiptIds: string[];
  synthesizedBy?: "human" | "distiller";
  synthesizedAt?: string;
}

/**
 * One Ledger receipt per task — feeds the status bar *and* the Distiller (PLAN R10).
 * Append-only, crash-safe (N4).
 */
export interface Receipt {
  id: string;
  taskClass: string;
  tier: Tier;
  /** Did a det short-circuit the model call? */
  detHit: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd: number;
  /** Tokens we avoided spending by hitting a det / extractor. */
  tokensAvoided: number;
  /** Inference steps a det collapsed into one structured call. */
  inferenceStepsSaved: number;
  /** output ÷ minimal-answer estimate; a spike signals uncertainty (PLAN succinctness). */
  verbosityRatio: number;
  verifyPassed?: boolean;
  startedAt: string;
  endedAt: string;
}

/** A Distiller proposal awaiting human review (PLAN R5). Lands in `.coder/proposals/`. */
export interface Proposal {
  id: string;
  kind: "capability" | "extractor";
  spec: CapabilitySpec | ExtractorSpec;
  /** Projected net savings: freq × tokensSaved − payback × synthCost. */
  projectedRoi: number;
  /** Result of replaying the synthesized det against real history. */
  replay: ReplayResult;
}

export interface ReplayResult {
  passed: boolean;
  fixturesRun: number;
  fixturesPassed: number;
  notes?: string;
}

/** Live registry stats aggregated from the Ledger (`.coder/registry.json`, PLAN R6). */
export interface RegistryEntry {
  name: string;
  kind: "capability" | "extractor";
  /** project-level dets win over global (~/.coder) — PLAN R6 precedence. */
  scope: "project" | "global";
  hits: number;
  tokensAvoided: number;
  lastUsedAt?: string;
}

/** How the Router classified an intake (PLAN R4). */
export type Classification = "det" | "command" | "free-text";
