import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpillWriter } from "../truncation";

export interface SpillSink {
  /** Where spill files land; expose to read tools as an extra readable root. */
  dir: string;
  write: SpillWriter;
  /** Remove the spill dir and everything in it. */
  close(): void;
}

/**
 * Session-scoped store for over-cap tool output. Writes are synchronous and
 * best-effort on purpose: they happen inside tool result paths that must never
 * fail, and only for the rare oversized output, so a failed write degrades to
 * plain truncation rather than surfacing an error.
 */
export const createSpillSink = (dir: string): SpillSink => {
  let sequence = 0;
  let ready = false;
  return {
    dir,
    write: (label, content) => {
      try {
        if (!ready) {
          mkdirSync(dir, { recursive: true });
          ready = true;
        }
        sequence += 1;
        const name = `${sequence.toString().padStart(4, "0")}-${
          label.replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 40) || "output"
        }.txt`;
        const path = join(dir, name);
        writeFileSync(path, content, "utf8");
        return path;
      } catch {
        return undefined;
      }
    },
    close: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
};
