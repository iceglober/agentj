// Context manager — context is a priority-ordered budget, assembled and trimmed every
// turn to hold *accuracy* (context rot degrades every frontier model as length grows)
// as much as cost (PLAN § "Context management", R7).
import type { ContextComposition } from "coder-core";

export interface BudgetTargets {
  /** Hard ceiling on total context tokens for the turn. */
  maxTotal: number;
  /** Cap on doc/AGENTS.md tokens. */
  maxDocs: number;
}

export interface ContextSlice {
  kind: keyof Omit<ContextComposition, "total" | "verbosityRatio">;
  /** Higher = kept first when trimming to target. */
  priority: number;
  tokens: number;
  render(): string;
}

/**
 * Assemble slices into context within the budget, trimming lowest-priority first.
 * Relevance-gated tools/dets, doc budgeting, and history compaction each produce slices.
 */
export function assemble(slices: ContextSlice[], targets: BudgetTargets): {
  kept: ContextSlice[];
  composition: ContextComposition;
} {
  const ordered = [...slices].sort((a, b) => b.priority - a.priority);
  const kept: ContextSlice[] = [];
  let total = 0;
  for (const s of ordered) {
    if (total + s.tokens > targets.maxTotal) continue; // trim by priority
    kept.push(s);
    total += s.tokens;
  }
  return { kept, composition: composition(kept, total) };
}

function composition(kept: ContextSlice[], total: number): ContextComposition {
  const sum = (k: ContextSlice["kind"]) =>
    kept.filter((s) => s.kind === k).reduce((n, s) => n + s.tokens, 0);
  return {
    system: sum("system"),
    tools: sum("tools"),
    docs: sum("docs"),
    history: sum("history"),
    files: sum("files"),
    verbosityRatio: 1,
    total,
  };
}

// TODO(P1/P3): relevance-gated tool/det injection + find_capability; doc/AGENTS.md
// budgeting (nearest full, ancestors summarized, subtree-on-touch, big docs chunked);
// long-horizon techniques — compaction, structured note-taking, sub-agent isolation.
