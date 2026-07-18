/**
 * Persists spilled-over tool output; returns the file path, or undefined when
 * spilling is unavailable or failed (the caller degrades to plain truncation).
 */
export type SpillWriter = (label: string, content: string) => string | undefined;

/**
 * Truncate like `truncateWithNotice`, but first persist the full value through
 * the spill writer so the cut content stays recoverable: the notice carries the
 * file path and how to slice it. Without a writer (or on write failure) this is
 * exactly `truncateWithNotice`.
 */
export const truncateWithSpill = (
  value: string,
  maxLength: number,
  spill?: SpillWriter,
  label = "output",
): string => {
  if (Array.from(value).length <= Math.max(0, Math.floor(maxLength))) return value;
  const path = spill?.(label, value);
  if (!path) return truncateWithNotice(value, maxLength);
  const pointer = `\n[full output: ${path}; read slices with readFile offset/limit or sed -n]`;
  return `${truncateWithNotice(value, Math.max(0, maxLength - pointer.length))}${pointer}`;
};

/** Truncate text while reserving room for an exact omitted-character notice. */
export const truncateWithNotice = (value: string, maxLength: number): string => {
  const characters = Array.from(value);
  const limit = Math.max(0, Math.floor(maxLength));
  if (characters.length <= limit) return value;

  let retained = Math.min(characters.length - 1, limit);
  while (true) {
    const omitted = characters.length - retained;
    const notice = `[trunc ${omitted} chars]`;
    const available = limit - notice.length;
    const nextRetained = Math.max(
      0,
      Math.min(characters.length - 1, available > 1 ? available - 1 : 0),
    );
    if (nextRetained === retained) {
      return `${characters.slice(0, retained).join("")}${retained > 0 ? " " : ""}${notice}`;
    }
    retained = nextRetained;
  }
};
