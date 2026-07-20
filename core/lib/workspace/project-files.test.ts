import { describe, expect, test } from "bun:test";
import { createProjectFileCatalog } from "./project-files";

describe("createProjectFileCatalog", () => {
  test("uses its injected source, bounds entries, and fuzzy-ranks suggestions", async () => {
    const catalog = createProjectFileCatalog(
      {
        listFiles: async () => [
          "src/agent-loop.ts",
          "README.md",
          "src/agent-loop.ts",
          "ignored.tmp",
        ],
      },
      { limit: 3 },
    );
    await catalog.refresh();
    expect(catalog.suggest("agt")).toEqual(["src/agent-loop.ts"]);
    expect(catalog.suggest("")).toEqual(["ignored.tmp", "README.md", "src/agent-loop.ts"]);
  });
});
