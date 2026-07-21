import type { GenerateRequest, RunResult, TokenUsage } from "../llm";
import { parseCompletionReport } from "../report";
import type { TodoPort } from "./todos";

const ACTIVE_DEFERRED_WORK =
  /\b(?:monitor(?:ing)?|watch(?:ing)?)\b.*\b(?:ci|checks?|release|review|workflow|job|pr)\b|\b(?:waiting|awaiting)\b.*\b(?:ci|checks?|release|review|workflow|job|pr)\b|\b(?:will|once|when)\b.*\b(?:merge|check|validate|monitor)\b/iu;
const NEGATED_DEFERRED_WORK =
  /\b(?:cannot|can't|unable to|will not|won't|not)\b.{0,32}\b(?:monitor|watch|wait|await)\b/iu;

const BACKGROUND_CORRECTIVE = `Your prior response claimed that background monitoring or future work had started, but no background job was created and that response was not shown to the user. Start the needed background work now. Your first action must be run_background_job. Use a build job if the work may merge, push, deploy, edit, or otherwise mutate; use a plan job only when all work is read-only. Do not claim that work is monitoring until run_background_job returns a job ID.`;

const DONE_CORRECTIVE = `Your prior response reported status=done, but this turn called no tools — so nothing was implemented and no validation command was actually run, and that response was not shown to the user. Do the work now with your file and bash tools, run every validation command you intend to claim, and only then report status=done. If the task cannot be completed this turn, report status=blocked or status=failed with the real reason.`;

const VALIDATION_CORRECTIVE = `Your prior response claimed passing validation that is not backed by a successful matching bash command in this turn, so it was not shown to the user. Run each validation command you intend to claim, report its exact command, and use status=done only when those commands succeed. Otherwise report the real failed or not-run outcome.`;

const TODOS_CORRECTIVE = `The session still has pending or in-progress todos, so your prior response was not shown to the user. Continue the remaining work now. Do not stop merely because there is a next step: use tools, fix failures, or start run_background_job for genuine external waiting. You may stop only after clearing or completing every todo, or with status=blocked/status=failed for a concrete hard blocker such as unavailable credentials, network, model, required user input, or a runtime error.`;

const blockedReport = (summary: string): string =>
  JSON.stringify({
    status: "blocked",
    summary,
    changes: [],
    validation: [],
    nextSteps: [],
    openQuestions: ["No background job is active."],
  });

const failedReport = (summary: string): string =>
  JSON.stringify({
    status: "failed",
    summary,
    changes: [],
    validation: [],
    nextSteps: [],
    openQuestions: ["No tool ran this turn, so nothing was implemented or validated."],
  });

const reportText = (text: string): string => {
  const report = parseCompletionReport(text);
  return report ? [report.summary, ...report.nextSteps, ...report.openQuestions].join("\n") : text;
};

/** A narrow check for a claim that external work is already being monitored. */
export const claimsActiveDeferredWork = (text: string): boolean => {
  const candidate = reportText(text);
  return ACTIVE_DEFERRED_WORK.test(candidate) && !NEGATED_DEFERRED_WORK.test(candidate);
};

/** A job is real only when the existing run_background_job tool returned its started-ID result. */
export const hasStartedBackgroundJob = (result: RunResult): boolean =>
  result.steps.some((step) =>
    step.toolResults.some(
      (toolResult) =>
        toolResult.name === "run_background_job" &&
        !toolResult.isError &&
        typeof toolResult.output === "string" &&
        /^Started background job\s+\S+/u.test(toolResult.output),
    ),
  );

/** Whether the turn called any tool at all — a done report needs at least one. */
export const hasAnyToolCall = (result: RunResult): boolean =>
  result.steps.some((step) => step.toolCalls.length > 0);

const normalizedCommand = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" ? command.trim().replace(/\s+/gu, " ") : null;
};

/** Commands a completion report calls passed must exist as successful bash results. */
export const hasGroundedPassedValidation = (result: RunResult): boolean => {
  const report = parseCompletionReport(result.text);
  if (!report) return true;
  const passed = report.validation.filter((item) => item.outcome === "passed");
  if (passed.length === 0) return true;

  const successful = new Set<string>();
  for (const step of result.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const toolResult = step.toolResults[index];
      if (call?.name !== "bash" || toolResult?.name !== "bash" || toolResult.isError) continue;
      const output = toolResult.output;
      if (
        typeof output === "object" &&
        output !== null &&
        (output as Record<string, unknown>).exitCode === 0
      ) {
        const command = normalizedCommand(call.input);
        if (command) successful.add(command);
      }
    }
  }
  return passed.every((item) => successful.has(item.command.trim().replace(/\s+/gu, " ")));
};

const addUsage = (first: TokenUsage, second: TokenUsage): TokenUsage => {
  const optional = (key: keyof TokenUsage): number | undefined => {
    const total = (first[key] ?? 0) + (second[key] ?? 0);
    return first[key] === undefined && second[key] === undefined ? undefined : total;
  };
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    totalTokens: first.totalTokens + second.totalTokens,
    ...(optional("noCacheInputTokens") !== undefined
      ? { noCacheInputTokens: optional("noCacheInputTokens") }
      : {}),
    ...(optional("cacheReadInputTokens") !== undefined
      ? { cacheReadInputTokens: optional("cacheReadInputTokens") }
      : {}),
    ...(optional("cacheWriteInputTokens") !== undefined
      ? { cacheWriteInputTokens: optional("cacheWriteInputTokens") }
      : {}),
  };
};

const combineResults = (first: RunResult, second: RunResult): RunResult => ({
  ...second,
  steps: [...first.steps, ...second.steps],
  usage: addUsage(first.usage, second.usage),
});

export interface CompletionGuard {
  generate(request: GenerateRequest): Promise<RunResult>;
}

export const hasOpenTodos = (todos: TodoPort | undefined): boolean =>
  todos?.list().some((todo) => todo.status !== "completed") ?? false;

export interface CompletionState {
  todos?: TodoPort;
}

/**
 * A final-response claim that is not backed by this turn's tool trajectory.
 * The two cases share one shape — detect, retry once with a targeted
 * correction, and otherwise replace the text with an honest failure report —
 * so both a fabricated "monitoring" claim and a fabricated "done" report flow
 * through a single grounding primitive rather than per-symptom guards.
 */
interface GroundingViolation {
  correctivePrompt: string;
  requiredFirstTool?: "run_background_job";
  /** True once the retry actually grounds the claim in tool activity. */
  isResolved(retry: RunResult): boolean;
  /** Returned immediately when a retry cannot ground the claim (no runner). */
  noRetryFailure?: string;
  /** Returned when the retry ran but the claim is still ungrounded. */
  unresolvedFailure: string;
  canRetry: boolean;
}

const detectViolation = (
  result: RunResult,
  request: GenerateRequest,
  state: CompletionState,
): GroundingViolation | null => {
  const report = parseCompletionReport(result.text);
  if (
    (report?.status === "in_progress" || claimsActiveDeferredWork(result.text)) &&
    !hasStartedBackgroundJob(result)
  ) {
    return {
      correctivePrompt: BACKGROUND_CORRECTIVE,
      requiredFirstTool: "run_background_job",
      isResolved: hasStartedBackgroundJob,
      noRetryFailure: blockedReport(
        "No background job was started because this session has no background-job runner.",
      ),
      unresolvedFailure: blockedReport(
        "No background job was started, so AgentJ is not monitoring this work.",
      ),
      canRetry: Boolean(request.tools.run_background_job),
    };
  }

  if (
    hasOpenTodos(state.todos) &&
    !hasStartedBackgroundJob(result) &&
    report?.status !== "blocked" &&
    report?.status !== "failed"
  ) {
    return {
      correctivePrompt: TODOS_CORRECTIVE,
      isResolved: (retry) =>
        !hasOpenTodos(state.todos) ||
        hasStartedBackgroundJob(retry) ||
        ["blocked", "failed"].includes(parseCompletionReport(retry.text)?.status ?? ""),
      unresolvedFailure: failedReport(
        "The agent stopped with open session todos and did not continue, start a background job, or report a concrete blocker.",
      ),
      canRetry: true,
    };
  }

  if (report?.status === "done" && !hasAnyToolCall(result)) {
    return {
      correctivePrompt: DONE_CORRECTIVE,
      isResolved: hasAnyToolCall,
      unresolvedFailure: failedReport(
        "The previous response reported done without running any tool, so no work was performed or validated.",
      ),
      canRetry: true,
    };
  }

  if (report?.status === "done" && !hasGroundedPassedValidation(result)) {
    return {
      correctivePrompt: VALIDATION_CORRECTIVE,
      isResolved: hasGroundedPassedValidation,
      unresolvedFailure: failedReport(
        "The completion report claimed passing validation without a matching successful bash command.",
      ),
      canRetry: true,
    };
  }

  return null;
};

/**
 * Keep a final response from claiming work the turn never did. A response that
 * says it is monitoring must have started a run_background_job; a status=done report must
 * have called at least one tool. When a claim is ungrounded, the model gets one
 * deterministic corrective retry, then the failure is stated explicitly instead
 * of becoming an unbounded loop or a false success.
 */
export async function generateWithGroundedCompletion(
  runtime: CompletionGuard,
  request: GenerateRequest,
  state: CompletionState = {},
): Promise<RunResult> {
  const first = await runtime.generate(request);
  const violation = detectViolation(first, request, state);
  if (!violation) return first;

  if (!violation.canRetry) {
    return { ...first, text: violation.noRetryFailure ?? violation.unresolvedFailure };
  }

  const retryPrompt = first.messages
    ? violation.correctivePrompt
    : `${request.prompt}\n\n${violation.correctivePrompt}`;
  const second = await runtime.generate({
    ...request,
    prompt: retryPrompt,
    ...(first.messages ? { messages: first.messages } : {}),
    ...(violation.requiredFirstTool ? { requiredFirstTool: violation.requiredFirstTool } : {}),
  });
  const combined = combineResults(first, second);
  return violation.isResolved(second)
    ? combined
    : { ...combined, text: violation.unresolvedFailure };
}
