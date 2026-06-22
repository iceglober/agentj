// Extractors — deterministic parsers that reduce noisy tool output (test/lint/build/
// git) to structured signal *before* it hits context; raw is spilled to disk (PLAN R2).
import type { ExtractorSpec } from "coder-core";

export interface ExtractResult {
  /** Structured high-signal payload that enters context. */
  structured: unknown;
  /** Path where the raw output was spilled (kept out of context). */
  rawPath: string;
  /** Tokens we estimate were kept out of context by this reduction. */
  tokensAvoided: number;
}

export interface Extractor {
  spec: ExtractorSpec;
  /** Reduce raw tool output to structured signal; spill raw to `spillDir`. */
  extract(raw: string, spillDir: string): Promise<ExtractResult>;
}

export class ExtractorRegistry {
  private readonly byTool = new Map<string, Extractor>();

  register(ext: Extractor): void {
    this.byTool.set(ext.spec.appliesTo, ext);
  }

  /** The extractor registered for a given tool's output, if any. */
  for(tool: string): Extractor | undefined {
    return this.byTool.get(tool);
  }
}

// TODO(P1): test/lint/build/git extractors. e.g. test → { passed, failed: [...] }.
// Also: read-dedup by content hash + head/tail truncation backpressure (glrs prior art,
// reimplemented clean — packages/harness-opencode/src/plugins/tool-hooks.ts).
