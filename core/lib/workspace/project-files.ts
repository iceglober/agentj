import { fuzzyFilter } from "../fuzzy";

/** Narrow port for project file discovery. UI code never reaches Git or the host. */
export interface ProjectFileSource {
  listFiles(): Promise<readonly string[]>;
}

export interface ProjectFileCatalog {
  refresh(): Promise<void>;
  suggest(query: string): readonly string[];
}

/** Session-scoped bounded catalog. Refresh is explicit so completion stays synchronous while typing. */
export const createProjectFileCatalog = (
  source: ProjectFileSource,
  options: { limit?: number } = {},
): ProjectFileCatalog => {
  const limit = options.limit ?? 10_000;
  let files: readonly string[] = [];
  return {
    async refresh() {
      files = [...new Set(await source.listFiles())]
        .filter((path) => path.length > 0)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit);
    },
    suggest(query) {
      return fuzzyFilter(query, files, (path) => path).slice(0, 100);
    },
  };
};
