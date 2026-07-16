import type { Agent } from "../agent";
import type { PlanningDagProgressEvent } from "../agent/planning-delegate";
import type { RunResult, RunStep } from "../llm";
import type { Sandbox } from "../sandbox";
import type { Session } from "../session";
import { assessBuildResult } from "./build-report";
import type { TaskRunEvent, TaskRunSessionIdentity } from "./run";

type ToolResult = RunStep["toolResults"][number];

export type ConversationPhase = "planning" | "awaiting-feedback" | "building";

export type ConversationEvent =
  | TaskRunEvent
  | { type: "sandbox-preparing"; image: string; bootstrapCount: number }
  | { type: "sandbox-ready" }
  | { type: "sandbox-failed"; error: string }
  | { type: "local-workspace"; root: string; branch: string; status: string }
  | { type: "project-setup"; commandCount: number; state: "running" | "complete" }
  | { type: "project-setup-failed"; error: string }
  | { type: "phase"; session: TaskRunSessionIdentity; phase: ConversationPhase }
  | { type: "plan"; session: TaskRunSessionIdentity; text: string; revision: number }
  | { type: "feedback"; session: TaskRunSessionIdentity; text: string }
  | {
      type: "subagent-progress";
      session: TaskRunSessionIdentity;
      progress: PlanningDagProgressEvent;
    }
  | {
      type: "build-blocked";
      session: TaskRunSessionIdentity;
      reason: string;
      recoveryCommitSha: string | null;
    }
  | { type: "local-complete"; session: TaskRunSessionIdentity };

export type ConversationOutcome =
  | {
      kind: "plan-ready";
      session: TaskRunSessionIdentity;
      plan: string;
    }
  | {
      kind: "success";
      session: TaskRunSessionIdentity;
      result: RunResult;
      commitSha: string | null;
    }
  | {
      kind: "generation-error";
      session?: TaskRunSessionIdentity;
      error: unknown;
    }
  | {
      kind: "commit-error";
      session: TaskRunSessionIdentity;
      result: RunResult;
      error: unknown;
    }
  | {
      kind: "aborted";
      session?: TaskRunSessionIdentity;
      error: unknown;
    }
  | {
      kind: "build-blocked";
      session: TaskRunSessionIdentity;
      reason: string;
      recoveryCommitSha: string | null;
    };

export interface ConversationDependencies {
  describeSandbox?(): Promise<{ image: string; bootstrapCount: number }>;
  createSandbox(): Promise<Sandbox>;
  createSession(sandbox: Sandbox): Promise<Session>;
  setupWorkspace?(sandbox: Sandbox, session: Session): Promise<number>;
  createAgent(args: {
    sandbox: Sandbox;
    session: Session;
    purpose: "planner" | "builder";
    onPlanningProgress?: (event: PlanningDagProgressEvent) => void | Promise<void>;
  }): Promise<Agent>;
  shouldIncludeToolResult?(toolResult: ToolResult): boolean;
}

export interface RunAgentConversationOptions {
  signal: AbortSignal;
  nextUserMessage?: () => Promise<string | null>;
  onEvent?: (event: ConversationEvent) => void | Promise<void>;
  dependencies: ConversationDependencies;
  maxFeedbackTurns?: number;
  initialState?: {
    plan: string;
    revision: number;
    feedback: string[];
    resumeBuilding?: boolean;
  };
}

const defaultShouldIncludeToolResult = (result: ToolResult): boolean =>
  result.name === "run_subagents";

const MAX_CONTEXT_MESSAGE_LENGTH = 12_000;
const bounded = (value: string): string => value.slice(0, MAX_CONTEXT_MESSAGE_LENGTH);

const sessionIdentity = (session: Session): TaskRunSessionIdentity => ({
  id: session.id,
  branch: session.branch,
  base: session.base,
  path: session.path,
  ...(session.baseWarning ? { baseWarning: session.baseWarning } : {}),
  ...(session.mode ? { mode: session.mode } : {}),
});

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";

const dispose = async (value: unknown): Promise<void> => {
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncDispose in value &&
    typeof value[Symbol.asyncDispose] === "function"
  ) {
    await (value as { [Symbol.asyncDispose]: () => Promise<void> })[Symbol.asyncDispose]();
    return;
  }
  if (typeof value === "object" && value !== null && "dispose" in value) {
    await (value as { dispose: () => Promise<void> }).dispose();
  }
};

export function isExplicitApproval(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "");
  return /^(proceed|build it|implement it|implement the plan|go ahead|approved)$/u.test(normalized);
}

const plannerPrompt = (task: string, plan: string | null, feedback: string[]): string =>
  [
    "Create an implementation plan for this request:",
    bounded(task),
    plan ? `\nCurrent draft plan:\n${bounded(plan)}` : "",
    feedback.length > 0 ? `\nUser feedback to incorporate:\n${feedback.join("\n")}` : "",
    "\nReturn only the revised, user-facing plan. Do not implement it.",
  ].join("\n");

const builderPrompt = (task: string, plan: string, feedback: string[]): string =>
  [
    "Implement the following approved request and plan end to end.",
    `\nOriginal request:\n${bounded(task)}`,
    `\nApproved plan:\n${bounded(plan)}`,
    feedback.length > 0 ? `\nPlanning feedback already incorporated:\n${feedback.join("\n")}` : "",
  ].join("\n");

export async function runAgentConversation(
  task: string,
  options: RunAgentConversationOptions,
): Promise<ConversationOutcome> {
  const { dependencies, signal } = options;
  const emit = async (event: ConversationEvent): Promise<void> => {
    await options.onEvent?.(event);
  };
  let sandbox: Sandbox | undefined;
  let session: Session | undefined;
  let identity: TaskRunSessionIdentity | undefined;
  let buildResult: RunResult | undefined;
  let outcome: ConversationOutcome | undefined;

  try {
    const sandboxDescription = await dependencies.describeSandbox?.();
    if (sandboxDescription) {
      await emit({ type: "sandbox-preparing", ...sandboxDescription });
    }
    try {
      sandbox = await dependencies.createSandbox();
    } catch (error) {
      await emit({
        type: "sandbox-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (sandboxDescription) await emit({ type: "sandbox-ready" });
    session = await dependencies.createSession(sandbox);
    identity = sessionIdentity(session);
    if (session.mode === "local") {
      await emit({
        type: "local-workspace",
        root: session.path,
        branch: session.branch,
        status: await session.status(),
      });
    }
    await emit({ type: "session-created", session: identity });
    if (dependencies.setupWorkspace) {
      try {
        const setupCount = await dependencies.setupWorkspace(sandbox, session);
        if (setupCount > 0) {
          await emit({ type: "project-setup", commandCount: setupCount, state: "complete" });
        }
      } catch (error) {
        await emit({
          type: "project-setup-failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const planner = await dependencies.createAgent({
      sandbox,
      session,
      purpose: "planner",
      onPlanningProgress: (progress) =>
        emit({ type: "subagent-progress", session: identity!, progress }),
    });
    const shouldInclude = dependencies.shouldIncludeToolResult ?? defaultShouldIncludeToolResult;
    const feedback: string[] = [...(options.initialState?.feedback ?? [])];
    let plan: string | null = options.initialState?.plan ?? null;
    let revision = options.initialState?.revision ?? 0;
    let needsPlanning = plan === null;
    let resumeBuilding = options.initialState?.resumeBuilding === true;

    const generate = async (agent: Agent, prompt: string): Promise<RunResult> =>
      agent.generate(prompt, {
        abortSignal: signal,
        onStep: async (step) => {
          for (const call of step.toolCalls) {
            await emit({ type: "tool-call", session: identity!, call });
          }
          for (const result of step.toolResults) {
            if (shouldInclude(result)) {
              await emit({ type: "tool-result", session: identity!, result });
            }
          }
        },
      });

    while (true) {
      if (needsPlanning) {
        await emit({ type: "phase", session: identity, phase: "planning" });
        const planned = await generate(planner, plannerPrompt(task, plan, feedback));
        plan = planned.text;
        revision += 1;
        needsPlanning = false;
      }
      if (plan === null) throw new Error("Planner returned no plan.");
      const currentPlan = plan;
      await emit({ type: "plan", session: identity, text: currentPlan, revision });
      await emit({ type: "phase", session: identity, phase: "awaiting-feedback" });

      const message = resumeBuilding ? "proceed" : await options.nextUserMessage?.();
      resumeBuilding = false;
      if (message == null) {
        outcome = { kind: "plan-ready", session: identity, plan: currentPlan };
        break;
      }
      const trimmed = message.trim();
      if (trimmed.length === 0) continue;
      await emit({ type: "feedback", session: identity, text: trimmed });

      if (isExplicitApproval(trimmed)) {
        await emit({ type: "phase", session: identity, phase: "building" });
        const builder = await dependencies.createAgent({ sandbox, session, purpose: "builder" });
        const buildToolCalls: RunStep["toolCalls"] = [];
        const buildToolResults: RunStep["toolResults"] = [];
        buildResult = await builder.generate(builderPrompt(task, currentPlan, feedback), {
          abortSignal: signal,
          onStep: async (step) => {
            buildToolCalls.push(...step.toolCalls);
            buildToolResults.push(...step.toolResults);
            for (const call of step.toolCalls) {
              await emit({ type: "tool-call", session: identity!, call });
            }
            for (const result of step.toolResults) {
              if (result.isError || shouldInclude(result)) {
                await emit({ type: "tool-result", session: identity!, result });
              }
            }
          },
        });
        if (buildResult.stepLimitReached && buildResult.text.trim() === "") {
          const observed = buildToolCalls.map((call, index) => ({
            tool: call.name,
            command:
              call.name === "bash" && typeof call.input === "object" && call.input !== null
                ? (call.input as Record<string, unknown>).command
                : undefined,
            failed: buildToolResults[index]?.isError === true,
          }));
          buildResult = await builder.generate(
            [
              "The tool-step budget was exhausted. Do not call tools.",
              `Original task: ${bounded(task)}`,
              `Approved plan: ${bounded(currentPlan)}`,
              `Observed tool status: ${bounded(JSON.stringify(observed))}`,
              "Return the required JSON completion report now. Claim passing validation only for observed commands marked failed=false.",
            ].join("\n\n"),
            { abortSignal: signal },
          );
        }
        const assessment = assessBuildResult(buildResult, buildToolCalls, buildToolResults);
        if (!assessment.ok) {
          const recoveryCommitSha = await session.commitAll(
            `agentj recovery: ${task.slice(0, 63)}`,
          );
          await emit({
            type: "build-blocked",
            session: identity,
            reason: assessment.reason,
            recoveryCommitSha,
          });
          outcome = {
            kind: "build-blocked",
            session: identity,
            reason: assessment.reason,
            recoveryCommitSha,
          };
          break;
        }
        buildResult = assessment.result;
        await emit({ type: "result", session: identity, result: buildResult });
        if (session.mode === "local") {
          await emit({ type: "local-complete", session: identity });
          outcome = { kind: "success", session: identity, result: buildResult, commitSha: null };
          break;
        }
        const message = `agentj: ${task.slice(0, 72)}`;
        const commitSha = await session.commitAll(message);
        await emit({
          type: "commit",
          session: identity,
          result: buildResult,
          message,
          sha: commitSha,
        });
        outcome = { kind: "success", session: identity, result: buildResult, commitSha };
        break;
      }

      feedback.push(bounded(trimmed));
      needsPlanning = true;
      if (feedback.length >= (options.maxFeedbackTurns ?? 12)) {
        outcome = { kind: "plan-ready", session: identity, plan: currentPlan };
        break;
      }
    }
  } catch (error) {
    outcome =
      signal.aborted || isAbortError(error)
        ? { kind: "aborted", session: identity, error }
        : buildResult
          ? { kind: "commit-error", session: identity!, result: buildResult, error }
          : { kind: "generation-error", session: identity, error };
  }

  let disposalError: unknown;
  if (session) await dispose(session).catch((error) => (disposalError = error));
  if (sandbox) await dispose(sandbox).catch((error) => (disposalError ??= error));
  if (disposalError && outcome?.kind === "success") {
    return {
      kind: "commit-error",
      session: identity!,
      result: outcome.result,
      error: disposalError,
    };
  }
  if (disposalError && outcome?.kind === "plan-ready") {
    return { kind: "generation-error", session: identity, error: disposalError };
  }
  return outcome!;
}
