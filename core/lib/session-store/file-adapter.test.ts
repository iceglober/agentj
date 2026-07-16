import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileSessionStore } from "./file-adapter";

test("persists and reloads a session manifest atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-session-store-"));
  try {
    const store = createFileSessionStore(root);
    const session = {
      id: "abc123",
      version: 1,
      projectRoot: "/repo",
      workspaceMode: "local" as const,
      task: "change it",
      phase: "planning" as const,
      plan: null,
      planRevision: 0,
      feedback: [],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    await store.create(session);
    await expect(store.load("abc123")).resolves.toEqual(session);
    await expect(store.load("missing")).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
