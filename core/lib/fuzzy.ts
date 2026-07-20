export interface FuzzyRank {
  kind: number;
  gaps: number;
  start: number;
}

export const fuzzyRank = (name: string, query: string): FuzzyRank | null => {
  if (query.length === 0) return { kind: 0, gaps: 0, start: 0 };
  if (name === query) return { kind: 0, gaps: 0, start: 0 };
  if (name.startsWith(query)) return { kind: 1, gaps: 0, start: 0 };

  let queryIndex = 0;
  let start = -1;
  let previous = -1;
  let gaps = 0;
  for (let nameIndex = 0; nameIndex < name.length && queryIndex < query.length; nameIndex += 1) {
    if (name[nameIndex] !== query[queryIndex]) continue;
    if (start === -1) start = nameIndex;
    if (previous !== -1) gaps += nameIndex - previous - 1;
    previous = nameIndex;
    queryIndex += 1;
  }
  return queryIndex === query.length ? { kind: 2, gaps, start } : null;
};

/** Case-insensitive exact, prefix, then compact ordered-subsequence matches. */
export const fuzzyFilter = <T>(
  query: string,
  entries: readonly T[],
  label: (entry: T) => string,
): T[] => {
  const normalized = query.toLowerCase();
  if (normalized.length === 0) return [...entries];
  return entries
    .map((entry, index) => ({
      entry,
      index,
      label: label(entry),
      rank: fuzzyRank(label(entry).toLowerCase(), normalized),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { rank: FuzzyRank } => candidate.rank !== null,
    )
    .sort(
      (left, right) =>
        left.rank.kind - right.rank.kind ||
        left.rank.gaps - right.rank.gaps ||
        left.rank.start - right.rank.start ||
        left.label.length - right.label.length ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
};
