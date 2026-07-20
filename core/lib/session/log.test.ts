import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChatLog, latestChatLogId, loadChatLog } from "./log";

test("append, load with last-state-wins, and torn-tail tolerance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chatlog-"));
  const projectRoot = "/repo/example";
  try {
    const log = await createChatLog({ root, projectRoot, title: "fix the flaky test" });
    await log.append({ type: "turn", mode: "plan", user: "hi", assistant: "hello", ts: "t1" });
    await log.append({ type: "state", messages: [{ role: "user" }], mode: "plan", ts: "t1" });
    await log.append({ type: "turn", mode: "build", user: "go", assistant: "done", ts: "t2" });
    await log.append({
      type: "state",
      messages: [{ role: "user" }, { role: "assistant" }],
      mode: "build",
      ts: "t2",
    });
    await appendFile(log.path, '{"type":"state","mess'); // torn tail from a crash

    const loaded = await loadChatLog({ root, projectRoot, id: log.id });
    expect(loaded?.meta.title).toBe("fix the flaky test");
    expect(loaded?.turns.map((turn) => turn.user)).toEqual(["hi", "go"]);
    expect(loaded?.state?.mode).toBe("build");
    expect(loaded?.state?.messages).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latestChatLogId picks the newest session for the project, null when none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chatlog-"));
  const projectRoot = "/repo/example";
  try {
    expect(await latestChatLogId({ root, projectRoot })).toBeNull();
    await createChatLog({ root, projectRoot, id: "older" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await createChatLog({ root, projectRoot, id: "newer" });
    expect(await latestChatLogId({ root, projectRoot })).toBe("newer");
    // A different project sees nothing.
    expect(await latestChatLogId({ root, projectRoot: "/repo/other" })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadChatLog returns null for unknown sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chatlog-"));
  try {
    expect(await loadChatLog({ root, projectRoot: "/repo/x", id: "nope" })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage records round-trip and logs without them load with an empty list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chatlog-"));
  const projectRoot = "/repo/example";
  try {
    const bare = await createChatLog({ root, projectRoot, id: "bare" });
    await bare.append({ type: "turn", mode: "plan", user: "hi", assistant: "hello", ts: "t1" });
    const legacy = await loadChatLog({ root, projectRoot, id: "bare" });
    expect(legacy?.usage).toEqual([]);

    const log = await createChatLog({ root, projectRoot, id: "metered" });
    const record = {
      type: "usage",
      provider: "azure",
      model: "gpt-5.6-terra",
      ts: "t1",
      usage: {
        inputTokens: 300_000,
        outputTokens: 1_200,
        cacheReadInputTokens: 250_000,
        longContextRequests: 1,
      },
    } as const;
    await log.append(record);
    const loaded = await loadChatLog({ root, projectRoot, id: "metered" });
    expect(loaded?.usage).toEqual([record]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reset state starts resumed history and usage at its boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chatlog-"));
  const projectRoot = "/repo/example";
  try {
    const log = await createChatLog({ root, projectRoot, id: "reset" });
    await log.append({
      type: "turn",
      mode: "plan",
      user: "old",
      assistant: "old answer",
      ts: "t1",
    });
    await log.append({
      type: "usage",
      provider: "azure",
      model: "old-model",
      ts: "t1",
      usage: { inputTokens: 10, outputTokens: 1, longContextRequests: 0 },
    });
    await log.append({ type: "state", messages: [{ old: true }], mode: "plan", ts: "t1" });
    await log.append({ type: "state", messages: [], mode: "build", ts: "t2", reset: true });
    await log.append({
      type: "turn",
      mode: "build",
      user: "new",
      assistant: "new answer",
      ts: "t3",
    });
    await log.append({
      type: "usage",
      provider: "azure",
      model: "new-model",
      ts: "t3",
      usage: { inputTokens: 20, outputTokens: 2, longContextRequests: 0 },
    });
    await log.append({ type: "state", messages: [{ fresh: true }], mode: "build", ts: "t3" });

    const loaded = await loadChatLog({ root, projectRoot, id: log.id });
    expect(loaded?.turns.map((turn) => turn.user)).toEqual(["new"]);
    expect(loaded?.usage.map((usage) => usage.model)).toEqual(["new-model"]);
    expect(loaded?.state).toMatchObject({ mode: "build", messages: [{ fresh: true }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
