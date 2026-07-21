import { z } from "zod";
import { defineTool } from "../llm";

/**
 * The run_background_job / check_background_job tools: detach one prompt into the session's
 * background-job runner — the same runner behind `&`-prefixed user input —
 * and manage it afterwards. The composition root injects the port; only an
 * interactive session provides a live runner, so one-shot runs report
 * unavailability instead of orphaning detached work.
 *
 * The port mirrors the chat JobRunner's surface (structurally — the agent
 * layer sits below chat and cannot import its types). `start` additionally
 * folds in availability, the one concern the runner does not have.
 */

export interface BackgroundJobInspection {
  id: string;
  status: "running" | "done" | "failed" | "aborted";
  prompt: string;
  startedAt: number;
  endedAt?: number;
  /** When set, the session pings the agent at this time if still running. */
  softTimeoutAt?: number;
  resultText?: string;
  /** Branch preserving the job's work when integration was blocked. */
  branch?: string;
  /** Non-fatal cleanup issues after job work completed. */
  warnings?: string[];
  /** Bounded tail of the job's tool calls, oldest first. */
  recentActivity: string[];
}

export interface BackgroundJobPort {
  start(
    mode: "plan" | "build",
    prompt: string,
    options?: { softTimeoutMs?: number },
  ): { id: string } | { error: string };
  inspect(id: string): BackgroundJobInspection | undefined;
  renewSoftTimeout(id: string, softTimeoutMs: number): boolean;
  abort(id: string): boolean;
}

export const backgroundJobInputSchema = z.object({
  /** Defaults to the calling agent's mode. Plan agents may only start plan jobs. */
  mode: z.enum(["plan", "build"]).optional(),
  prompt: z.string().min(1),
  /** Ping the agent if the job is still running after this long (renewable). */
  softTimeoutMinutes: z.number().min(1).max(720).optional(),
});

export const checkJobInputSchema = z.object({
  id: z.string().min(1),
  /** Re-arm the soft timeout this many minutes from now (healthy but slow job). */
  renewSoftTimeoutMinutes: z.number().min(1).max(720).optional(),
  /** Kill the job (stuck or misbehaving). */
  abort: z.boolean().optional(),
});

const BACKGROUND_WORKER_CONTEXT = `You are a fresh-context background worker continuing work in the same repository and authenticated host environment as the foreground agent.
Inspect the workspace and attempt the relevant command or tool before claiming that repository context, credentials, or access are unavailable. Quote the exact failure if an attempt fails. Do not ask for information that the task, git metadata, or available tools can supply.`;

export const prepareBackgroundJobPrompt = (prompt: string): string =>
  `${BACKGROUND_WORKER_CONTEXT}\n\nTask:\n${prompt}`;

const formatSpan = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
};

export const createBackgroundJobTool = (port: BackgroundJobPort, agentMode: "plan" | "build") =>
  defineTool({
    description: [
      "Detach a task into a background job: it runs its own agent and outlives this turn,",
      "returning immediately with a job id. The job's outcome is shown to the user when it",
      "finishes and reported to you as a notice at the start of a later turn — never wait or",
      "poll for it yourself.",
      "Use this only when work must wait on something external (a CI run, a code review, a",
      "deploy) or when the user explicitly wants it detached from this turn. If the current",
      "turn needs the result, use a foreground tool or subagent instead, even when the task is",
      'long. Example: "wait for checks on PR 12, then fix any failures".',
      "When you can estimate the duration, set softTimeoutMinutes a little above it: if the",
      "job is still running then, you are pinged to check_background_job it — the job keeps running, and",
      "you either renew the soft timeout (progressing, just slow) or abort it (stuck).",
      "mode plan runs an observe-only agent in the session directory — it reads, searches,",
      "and runs non-mutating commands (CI status, git state, tests) but cannot edit; mode",
      "build runs in an isolated worktree and integrates its commits when done.",
    ].join("\n"),
    inputSchema: backgroundJobInputSchema,
    execute: async ({ mode, prompt, softTimeoutMinutes }) => {
      if (agentMode === "plan" && mode === "build") {
        return "Plan mode can only start plan (read-only) jobs. Start a plan job, or ask the user to switch to build mode.";
      }
      const effective = agentMode === "plan" ? "plan" : (mode ?? "build");
      const result = port.start(
        effective,
        prompt,
        softTimeoutMinutes !== undefined
          ? { softTimeoutMs: softTimeoutMinutes * 60_000 }
          : undefined,
      );
      if ("error" in result) return result.error;
      const pinged =
        softTimeoutMinutes !== undefined
          ? ` You will be pinged if it is still running after ${softTimeoutMinutes} minutes.`
          : "";
      return `Started background job ${result.id} (${effective}). Do not wait for it; its outcome arrives on a later turn.${pinged}`;
    },
  });

export const createCheckJobTool = (port: BackgroundJobPort, now: () => number = Date.now) =>
  defineTool({
    description: [
      "Inspect a background job (started with run_background_job, or by the user with `&`): status,",
      "elapsed time, recent tool activity, and its result when finished. When a soft-timeout",
      "ping asked you to check a job, decide from the activity trail: set",
      "renewSoftTimeoutMinutes to keep a healthy-but-slow job running (you will be pinged",
      "again), or set abort to true to kill a stuck one. Renew and abort are mutually",
      "exclusive.",
    ].join("\n"),
    inputSchema: checkJobInputSchema,
    execute: async ({ id, renewSoftTimeoutMinutes, abort }) => {
      const job = port.inspect(id);
      if (!job) return `No background job ${id} in this session.`;
      const lines: string[] = [];
      const elapsed = (job.endedAt ?? now()) - job.startedAt;
      lines.push(`[${job.id}] ${job.status} — ${formatSpan(elapsed)} — ${job.prompt.slice(0, 80)}`);
      if (job.status === "running" && job.softTimeoutAt !== undefined) {
        const remaining = job.softTimeoutAt - now();
        lines.push(
          remaining > 0
            ? `soft timeout in ${formatSpan(remaining)}`
            : `soft timeout passed ${formatSpan(-remaining)} ago`,
        );
      }
      if (job.recentActivity.length > 0) {
        lines.push("recent tool calls:", ...job.recentActivity.map((entry) => `  ${entry}`));
      }
      if (job.resultText) lines.push(`result: ${job.resultText.slice(0, 2_000)}`);
      if (job.warnings?.length)
        lines.push("warnings:", ...job.warnings.map((warning) => `  ${warning}`));
      if (job.branch) lines.push(`work preserved on ${job.branch}`);
      if (abort) {
        lines.push(port.abort(id) ? `Aborted ${id}.` : `${id} is not running; nothing to abort.`);
      } else if (renewSoftTimeoutMinutes !== undefined) {
        lines.push(
          port.renewSoftTimeout(id, renewSoftTimeoutMinutes * 60_000)
            ? `Soft timeout renewed: you will be pinged again in ${renewSoftTimeoutMinutes} minutes if it is still running.`
            : `${id} is not running; soft timeout not renewed.`,
        );
      }
      return lines.join("\n");
    },
  });
