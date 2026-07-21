import type { BackgroundJobPort } from "../agent/background-jobs";
import type { QuestionPort } from "../agent/questions";
import type { TodoPort } from "../agent/todos";
import type { JobRunner } from "./jobs";

export interface InteractiveCapabilities {
  jobs: Pick<JobRunner, "start" | "inspect" | "renewSoftTimeout" | "abort">;
  todos: TodoPort;
  questions: QuestionPort;
}

/**
 * Stable agent-facing ports whose interactive implementations are attached
 * after the chat session has been constructed.
 */
export const createInteractiveCapabilityBinder = (): {
  jobs: BackgroundJobPort;
  todos: TodoPort;
  questions: QuestionPort;
  attach(capabilities: InteractiveCapabilities): void;
} => {
  let runtime: InteractiveCapabilities | undefined;

  return {
    jobs: {
      start: (mode, prompt, options) =>
        runtime
          ? { id: runtime.jobs.start(mode, prompt, options).id }
          : { error: "Background jobs are unavailable in this session." },
      inspect: (id) => runtime?.jobs.inspect(id),
      renewSoftTimeout: (id, softTimeoutMs) =>
        runtime?.jobs.renewSoftTimeout(id, softTimeoutMs) ?? false,
      abort: (id) => runtime?.jobs.abort(id) ?? false,
    },
    todos: {
      list: () => runtime?.todos.list() ?? [],
      replace: async (items) => {
        if (!runtime) throw new Error("Session todos are unavailable in this session.");
        await runtime.todos.replace(items);
      },
    },
    questions: {
      ask: async (questions) => {
        if (!runtime) throw new Error("User questions are unavailable in this session.");
        return runtime.questions.ask(questions);
      },
    },
    attach: (capabilities) => {
      runtime = capabilities;
    },
  };
};
