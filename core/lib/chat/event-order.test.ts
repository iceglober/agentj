import { describe, expect, test } from "bun:test";
import { createChatEventOrderer } from "./event-order";
import type { ChatEvent, JobView } from "./events";

const job = (id: string): JobView => ({
  id,
  mode: "build",
  prompt: `job ${id}`,
  status: "done",
  startedAt: 0,
  endedAt: 1,
});

describe("createChatEventOrderer", () => {
  test("renders idle job completions immediately", () => {
    const events: ChatEvent[] = [];
    const orderer = createChatEventOrderer((event) => events.push(event));

    orderer.emit({ type: "job-finished", job: job("j1") });

    expect(events).toEqual([{ type: "job-finished", job: job("j1") }]);
  });

  test("keeps starts immediate and completion after a foreground submission", () => {
    const events: ChatEvent[] = [];
    const orderer = createChatEventOrderer((event) => events.push(event));

    orderer.emit({ type: "turn-started", mode: "build", text: "work" });
    orderer.emit({ type: "job-started", job: { ...job("j1"), status: "running" } });
    orderer.emit({ type: "assistant", mode: "build", text: "done" });
    orderer.emit({ type: "job-finished", job: job("j1") });
    expect(events.map((event) => event.type)).toEqual(["turn-started", "job-started", "assistant"]);

    orderer.emit({ type: "submission-finished" });

    expect(events.map((event) => event.type)).toEqual([
      "turn-started",
      "job-started",
      "assistant",
      "submission-finished",
      "job-finished",
    ]);
  });

  test("keeps completion order and flushes before the next submission starts", () => {
    const events: ChatEvent[] = [];
    const orderer = createChatEventOrderer((event) => events.push(event));

    orderer.emit({ type: "turn-started", mode: "plan", text: "first" });
    orderer.emit({ type: "job-finished", job: job("j1") });
    orderer.emit({ type: "job-finished", job: job("j2") });
    orderer.emit({ type: "submission-finished" });
    orderer.emit({ type: "turn-started", mode: "plan", text: "next" });

    expect(
      events.map((event) => (event.type === "job-finished" ? event.job.id : event.type)),
    ).toEqual(["turn-started", "submission-finished", "j1", "j2", "turn-started"]);
  });

  test("keeps completions buffered through a plan reflection exchange", () => {
    const events: ChatEvent[] = [];
    const orderer = createChatEventOrderer((event) => events.push(event));

    orderer.emit({ type: "turn-started", mode: "plan", text: "draft" });
    orderer.emit({ type: "turn-finished" });
    orderer.emit({ type: "job-finished", job: job("j1") });
    orderer.emit({ type: "notice", text: "Reflections: architecture" });
    orderer.emit({ type: "turn-started", mode: "plan", text: "revised" });
    orderer.emit({ type: "assistant", mode: "plan", text: "revised plan" });
    orderer.emit({ type: "submission-finished" });

    expect(
      events.map((event) => (event.type === "job-finished" ? event.job.id : event.type)),
    ).toEqual([
      "turn-started",
      "turn-finished",
      "notice",
      "turn-started",
      "assistant",
      "submission-finished",
      "j1",
    ]);
  });
});
