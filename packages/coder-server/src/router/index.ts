// Router — the intake gate (PLAN R4). Classifies input and routes it the cheapest way:
//   det match / whitelist  → Capability, 0 model tokens
//   `/`-prefixed           → command bar
//   free-text              → cheapest capable tier (escalate on verify-fail or
//                            verbosity spike — the spike is an uncertainty signal)
import type { Classification, Tier } from "coder-core";

export interface RouteDecision {
  classification: Classification;
  /** Set when classification === "det": the Capability to run with zero model tokens. */
  capability?: string;
  /** Set when classification === "command": the `/`-command name. */
  command?: string;
  /** Set when classification === "free-text": the cheapest tier to start at. */
  tier?: Tier;
}

export interface RouterDeps {
  /** Names of registered Capabilities, used to match deterministic intents. */
  capabilityNames: Set<string>;
  /** Whether a free-text intent maps deterministically to a Capability. */
  matchDet(text: string): string | undefined;
}

export function classify(input: string, deps: RouterDeps): RouteDecision {
  const trimmed = input.trim();

  if (trimmed.startsWith("/")) {
    return { classification: "command", command: trimmed.slice(1).split(/\s+/)[0] };
  }

  const det = deps.matchDet(trimmed);
  if (det && deps.capabilityNames.has(det)) {
    return { classification: "det", capability: det };
  }

  // Free-text → cheapest tier by default; escalation happens downstream.
  return { classification: "free-text", tier: "cheap" };
}

/**
 * Escalation hook: the Ledger feeds verify-fail and verbosity-spike signals back here
 * to bump the tier (PLAN R4/succinctness — a verbosity spike means low confidence).
 */
export function escalate(current: Tier): Tier {
  const order: Tier[] = ["cheap", "fast", "mid", "deep"];
  const i = order.indexOf(current);
  return order[Math.min(i + 1, order.length - 1)];
}
