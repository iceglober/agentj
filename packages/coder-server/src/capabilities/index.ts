// Capabilities — deterministic, *structured* ops callable by the agent (as tools) and
// the user (`/`). One typed answer, no model call, <100ms, no network (PLAN R1, N2).
// Designed per the deterministic-tool principles: structured high-signal results,
// sensible default limits, no opaque-ID returns.
import type { CapabilitySpec } from "coder-core";

/** A runnable Capability: spec + a pure-ish handler returning structured data. */
export interface Capability<Input = unknown, Output = unknown> {
  spec: CapabilitySpec;
  run(input: Input, ctx: CapabilityContext): Promise<Output>;
}

export interface CapabilityContext {
  /** Worktree root — every Capability operates relative to it. */
  worktreeRoot: string;
}

/** In-memory registry of Capabilities, relevance-gated into context (PLAN R7). */
export class CapabilityRegistry {
  private readonly byName = new Map<string, Capability>();

  register(cap: Capability): void {
    this.byName.set(cap.spec.name, cap as Capability);
  }

  get(name: string): Capability | undefined {
    return this.byName.get(name);
  }

  names(): Set<string> {
    return new Set(this.byName.keys());
  }

  /** `find_capability` meta-tool backing: top-N by naive relevance to a query (PLAN R7). */
  find(query: string, limit = 5): CapabilitySpec[] {
    const q = query.toLowerCase();
    return [...this.byName.values()]
      .map((c) => c.spec)
      .filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, limit);
  }
}

// TODO(P1): first Capabilities — pr_status, test_results, find_def, git_state.
// Each is deterministic structured I/O, registered here and surfaced as a tool + `/`.
