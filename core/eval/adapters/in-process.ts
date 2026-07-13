import { createAgent } from "../../lib/agent";
import type { RunConfig } from "../../lib/eval/config";
import type { AgentAdapter, Env, Task, Trajectory } from "../../lib/eval/types";
import type { PromptContext } from "../../lib/prompt";
import type { Sandbox } from "../../lib/sandbox";

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * The default adapter: run the agent in this process against the trial's Env,
 * capped at the task's step budget and aborted at its timeout. Never throws —
 * a caught error becomes `trajectory.error` (verdict "error"); a timeout sets
 * `timedOut` instead. `finalDiff`/`filesTouched` are left empty; the runner
 * fills them from the Env so exactly one place owns that.
 */
export function createInProcessAdapter(sb: Sandbox): AgentAdapter<RunConfig> {
  let cachedOs: string | undefined;
  const uname = async () => {
    if (cachedOs === undefined) cachedOs = (await sb.executeCommand("uname -sr")).stdout.trim();
    return cachedOs;
  };

  return {
    name: "in-process",
    async run(task: Task, env: Env, config: RunConfig): Promise<Trajectory> {
      const started = Date.now();
      const empty = (over: Partial<Trajectory>): Trajectory => ({
        toolCalls: [],
        toolResults: [],
        finalText: "",
        finalDiff: "",
        filesTouched: [],
        usage: EMPTY_USAGE,
        steps: 0,
        wallMs: Date.now() - started,
        ...over,
      });

      let composedVersion = "";
      const signal = AbortSignal.timeout(task.timeoutSec * 1000);
      try {
        const ctx: PromptContext = {
          cwd: env.dir,
          os: await uname(),
          date: new Date().toISOString().slice(0, 10),
          gitBranch: "main",
          gitStatusSummary: "clean",
        };

        const { agent, composed } = await createAgent(sb, config.agent, {
          root: env.dir,
          ctx,
          stopSteps: task.budget.steps,
        });
        composedVersion = composed.version;

        const result = await agent.generate({ prompt: task.prompt, abortSignal: signal });

        const toolCalls: Trajectory["toolCalls"] = [];
        const toolResults: Trajectory["toolResults"] = [];
        result.steps.forEach((step, i) => {
          for (const call of step.toolCalls)
            toolCalls.push({ step: i, name: call.toolName, input: call.input });
          for (const tr of step.toolResults) {
            const output = (tr as { output?: unknown }).output;
            toolResults.push({
              step: i,
              name: tr.toolName,
              output,
              isError: typeof output === "string" && output.startsWith("ERROR"),
            });
          }
        });

        const usage = (result as { totalUsage?: typeof result.usage }).totalUsage ?? result.usage;
        return {
          toolCalls,
          toolResults,
          finalText: result.text,
          finalDiff: "",
          filesTouched: [],
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          },
          steps: result.steps.length,
          wallMs: Date.now() - started,
          promptVersion: composedVersion,
        };
      } catch (err) {
        // AbortSignal.timeout firing → a timeout, not a harness error.
        if (signal.aborted)
          return empty({ timedOut: true, promptVersion: composedVersion });
        return empty({ error: String(err), promptVersion: composedVersion });
      }
    },
  };
}
