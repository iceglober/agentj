import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPromptHistory } from "./prompt-history";

test("persists exact prompts and shares history by common Git directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "agentj-prompt-history-"));
  const root = path.join(parent, "history");
  try {
    const mainWorktree = await createPromptHistory({
      root,
      projectIdentity: "/repo/example/.git",
    });
    await mainWorktree.append("first prompt");
    await mainWorktree.append("  multiline\n\nprompt  ");
    await mainWorktree.append("  multiline\n\nprompt  ");
    await mainWorktree.append("   ");

    const linkedWorktree = await createPromptHistory({
      root,
      projectIdentity: "/repo/example/.git",
    });
    expect(linkedWorktree.path).toBe(mainWorktree.path);
    expect(linkedWorktree.entries).toEqual(["first prompt", "  multiline\n\nprompt  "]);

    const otherClone = await createPromptHistory({
      root,
      projectIdentity: "/other/example/.git",
    });
    expect(otherClone.path).not.toBe(mainWorktree.path);
    expect(otherClone.entries).toEqual([]);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(mainWorktree.path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("keeps the newest entries and tolerates malformed JSONL records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-prompt-history-"));
  try {
    const history = await createPromptHistory({
      root,
      projectIdentity: "/repo/example/.git",
      maxEntries: 3,
    });
    await history.append("one");
    await appendFile(
      history.path,
      '{"type":"prompt","text":"two"}\nnot-json\n{"type":"other","text":"ignored"}\n' +
        '{"type":"prompt","text":"three"}\n{"type":"prompt","text":"four"}\n{"type":"prompt",',
    );

    const loaded = await createPromptHistory({
      root,
      projectIdentity: "/repo/example/.git",
      maxEntries: 3,
    });
    expect(loaded.entries).toEqual(["two", "three", "four"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
