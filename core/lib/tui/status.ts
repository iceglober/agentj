import type { ChatMode } from "../session/log";
import { truncateWithNotice } from "../truncation";

const SPINNER = ["◐", "◓", "◑", "◒"];

export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
};

/** 456 → "456", 2437 → "2.4k", 432_312 → "432.3k". */
const formatStatusTokens = (count: number): string =>
  count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;

/** Left and right hugging opposite edges; joined loosely when they cannot. */
const splitEnds = (left: string, right: string, width: number): string => {
  if (right.length === 0) return left;
  const gap = width - left.length - right.length;
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : `${left}  ${right}`;
};

/** Long paths keep their head and leaf: ~/repos/…/nested/repo. */
const middleEllipsis = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.max(1, Math.floor((max - 1) * 0.4));
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};

export interface StatusSectionState {
  sessionId: string;
  /** Package version shown beside the session root. */
  version: string;
  /** Display path of the directory the session started in — the root the
   *  session orchestrates from, however many worktrees the work fans into. */
  root: string;
  /** Provider/model label, e.g. "azure/gpt-5.6-sol". */
  model: string;
  mode: ChatMode;
  spinnerFrame: number;
  /** Cumulative request/response tokens; ctx is the latest request's size and
   *  cacheRead the session's cumulative provider-cache read tokens. */
  usage: { in: number; out: number; ctx: number; cacheRead?: number };
  /** When set and ctx has reached it, the ctx counter renders flagged. */
  contextSoftLimit?: number;
  sessionStartedAt: number;
  /** Running background jobs only — each gets its own row. */
  jobs: ReadonlyArray<{ id: string; mode: ChatMode; prompt: string; startedAt: number }>;
  now?: number;
}

/**
 * The status section below the editor: identity line, root-path line, then one
 * row per running background job. Foreground activity renders above the editor.
 */
export const composeThinkingLine = (
  state: {
    thinking: boolean;
    interruptRequested: boolean;
    spinnerFrame: number;
    turnStartedAt: number | null;
    now?: number;
  },
  width: number,
): string | null => {
  if (!state.thinking) return null;
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";
  const elapsed =
    state.turnStartedAt === null
      ? ""
      : ` ${Math.round(((state.now ?? Date.now()) - state.turnStartedAt) / 1000)}s`;
  return truncateWithNotice(
    `${frame} ${state.interruptRequested ? "interrupting…" : "thinking"}${elapsed}${state.interruptRequested ? "" : " (esc)"}`,
    width,
  );
};

/** Re-warn after enough growth to be useful without repeating every step. */
export const contextWarningRearmThreshold = (softLimit: number): number =>
  Math.max(1, Math.ceil(softLimit * 0.1));

/**
 * Warn when the latest request first reaches the soft limit, then re-arm once
 * the context has grown another tenth of that limit beyond the last warning.
 */
export const shouldWarnContext = (
  ctx: number,
  softLimit: number | undefined,
  lastWarnedContext: number | undefined,
): boolean =>
  softLimit !== undefined &&
  ctx >= softLimit &&
  (lastWarnedContext === undefined ||
    ctx >= lastWarnedContext + contextWarningRearmThreshold(softLimit));

export const composeStatusSection = (state: StatusSectionState, width: number): string[] => {
  const now = state.now ?? Date.now();
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";

  const left = `${state.sessionId} · ${state.model} · ${state.mode} (tab↕)`;
  const clock = formatClock(now - state.sessionStartedAt);
  const overLimit =
    state.contextSoftLimit !== undefined && state.usage.ctx >= state.contextSoftLimit;
  const counters = [
    formatStatusTokens(state.usage.in),
    formatStatusTokens(state.usage.out),
    `${formatStatusTokens(state.usage.ctx)}${overLimit ? "!" : ""}`,
  ] as const;
  // Session-cumulative cache reads as a share of cumulative input: how much
  // of everything sent so far was served from the provider's prefix cache.
  // Dropped in the compact form — width wins there.
  const cacheRead = state.usage.cacheRead;
  const cached =
    cacheRead === undefined || state.usage.in <= 0
      ? ""
      : ` · cached ${formatStatusTokens(cacheRead)}(${Math.round((cacheRead / state.usage.in) * 100)}%)`;
  const labeled = `in ${counters[0]}${cached} ▸ out ${counters[1]} · ctx ${counters[2]} · ${clock}`;
  const compact = `${counters[0]}▸${counters[1]}·${counters[2]}·${clock}`;
  const right = left.length + 2 + labeled.length <= width ? labeled : compact;
  const identity = splitEnds(left, right, width);

  const version = `aj ${state.version}`;
  const rootWidth = Math.max(0, width - version.length - 2);
  const location = splitEnds(
    rootWidth > 0 ? middleEllipsis(state.root, rootWidth) : "",
    version,
    width,
  );

  const jobRows = state.jobs.map((job) => {
    const firstLine = job.prompt.split("\n")[0] ?? "";
    const snippet = firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
    return `  ${frame} [${job.id}] ${job.mode}: ${snippet}  ${formatClock(now - job.startedAt)}`;
  });

  return [identity, location, ...jobRows];
};
