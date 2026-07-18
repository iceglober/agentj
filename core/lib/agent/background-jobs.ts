import { z } from "zod";
import { defineTool } from "../llm";

/**
 * The run_job tool: detach one prompt into the session's background-job
 * runner — the same runner behind `&`-prefixed user input — and return
 * immediately. The composition root injects the port; only an interactive
 * session provides a live starter, so one-shot runs report unavailability
 * instead of orphaning detached work.
 */

export interface BackgroundJobPort {
  start(mode: "plan" | "build", prompt: string): { id: string } | { error: string };
}

export const backgroundJobInputSchema = z.object({
  /** Defaults to the calling agent's mode. Plan agents may only start plan jobs. */
  mode: z.enum(["plan", "build"]).optional(),
  prompt: z.string().min(1),
});

export const createBackgroundJobTool = (port: BackgroundJobPort, agentMode: "plan" | "build") =>
  defineTool({
    description: [
      "Detach a task into a background job: it runs its own agent and outlives this turn,",
      "returning immediately with a job id. The job's outcome is shown to the user when it",
      "finishes and reported to you as a notice at the start of a later turn — never wait or",
      "poll for it yourself.",
      "Use this instead of sleeping or polling in the foreground whenever a task must wait on",
      "something external (a CI run, a code review, a deploy) or is long and independent of",
      'the current conversation, e.g. "wait for checks on PR 12, then fix any failures".',
      "mode plan runs a read-only agent in the session directory; mode build runs in an",
      "isolated worktree and integrates its commits when done.",
    ].join("\n"),
    inputSchema: backgroundJobInputSchema,
    execute: async ({ mode, prompt }) => {
      if (agentMode === "plan" && mode === "build") {
        return "Plan mode can only start plan (read-only) jobs. Start a plan job, or ask the user to switch to build mode.";
      }
      const effective = agentMode === "plan" ? "plan" : (mode ?? "build");
      const result = port.start(effective, prompt);
      if ("error" in result) return result.error;
      return `Started background job ${result.id} (${effective}). Do not wait for it; its outcome arrives on a later turn.`;
    },
  });
