// Registry loaders for `.coder/` dets. Dets are files: project `.coder/{capabilities,
// extractors}/<name>` (committed, team-shared) + global `~/.coder/` (personal).
// Project wins over global (PLAN R6 precedence). `.coder/registry.json` aggregates
// metadata + live stats updated from the Ledger.

import { homedir } from "node:os";
import { join } from "node:path";
import type { RegistryEntry } from "./types.ts";

/** Resolve the two registry roots, project-first (precedence order). */
export function registryRoots(worktreeRoot: string): string[] {
  return [join(worktreeRoot, ".coder"), join(homedir(), ".coder")];
}

export interface Registry {
  entries: RegistryEntry[];
  /** Look up a det by name, honoring project > global precedence. */
  resolve(name: string): RegistryEntry | undefined;
}

/** Merge project + global entries; project scope shadows global on name collision. */
export function mergeRegistries(project: RegistryEntry[], global: RegistryEntry[]): Registry {
  const byName = new Map<string, RegistryEntry>();
  for (const e of global) byName.set(e.name, e);
  for (const e of project) byName.set(e.name, e); // project wins
  const entries = [...byName.values()];
  return {
    entries,
    resolve: (name) => byName.get(name),
  };
}

// TODO(P1/P3): read det files from disk, validate fixtures + provenance, and
// reconcile live stats (hits, tokens-avoided, last-used) from the Ledger.
