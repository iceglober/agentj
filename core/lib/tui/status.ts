import type { ChatMode } from "../session/log";
import { splitGraphemes } from "./editor";
import { displayWidth, graphemeWidth, truncateToDisplayWidth } from "./terminal-editor";

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

/** 456 → "456", 2437 → "2.4k", 1_952_300 → "2.0m". */
const formatStatusTokens = (count: number): string => {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
};

const normalizedWidth = (width: number): number => Math.max(0, Math.floor(width));

/** Long paths keep their head and leaf: ~/repos/…/nested/repo. */
const middleEllipsis = (text: string, maxWidth: number): string => {
  const width = normalizedWidth(maxWidth);
  if (displayWidth(text) <= width) return text;
  if (width === 0) return "";
  if (width === 1) return "…";

  const graphemes = splitGraphemes(text);
  const available = width - 1;
  const headBudget = Math.max(1, Math.floor(available * 0.4));
  let head = "";
  let headWidth = 0;
  let index = 0;
  while (index < graphemes.length) {
    const grapheme = graphemes[index] ?? "";
    const nextWidth = headWidth + graphemeWidth(grapheme);
    if (nextWidth > headBudget) break;
    head += grapheme;
    headWidth = nextWidth;
    index += 1;
  }

  let tail = "";
  let tailWidth = 0;
  for (let tailIndex = graphemes.length - 1; tailIndex >= index; tailIndex -= 1) {
    const grapheme = graphemes[tailIndex] ?? "";
    const nextWidth = headWidth + tailWidth + graphemeWidth(grapheme);
    if (nextWidth > available) break;
    tail = `${grapheme}${tail}`;
    tailWidth += graphemeWidth(grapheme);
  }
  return `${head}…${tail}`;
};

export interface StatusSectionState {
  /** Display path of the directory the session started in — the root the
   *  session orchestrates from, however many worktrees the work fans into. */
  root: string;
  /** Provider/model label, e.g. "azure/gpt-5.6-sol". */
  model: string;
  mode: ChatMode;
  spinnerFrame: number;
  /** Latest request's context size. */
  usage: { ctx: number };
  /** When set, ctx displays against this soft limit (for example, 8.7k/8.0k). */
  contextSoftLimit?: number;
  /** Running background jobs only — each gets its own row. */
  jobs: ReadonlyArray<{ id: string; mode: ChatMode; prompt: string; startedAt: number }>;
  now?: number;
}

/** The always-visible foreground state immediately above the composer. */
export const composePresenceLine = (
  state: {
    busy: boolean;
    interruptRequested: boolean;
    spinnerFrame: number;
    turnStartedAt: number | null;
    activeTools?: number;
    queued?: number;
    now?: number;
  },
  width: number,
): string => {
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";
  const elapsed =
    state.turnStartedAt === null
      ? ""
      : ` ${Math.round(((state.now ?? Date.now()) - state.turnStartedAt) / 1000)}s`;
  const queued = state.queued ? ` · ${state.queued} queued` : "";
  if (state.interruptRequested)
    return truncateToDisplayWidth(`${frame} Stopping safely…${queued}`, width);
  if (state.busy) {
    const activity = state.activeTools ? "Working" : "Thinking";
    const full = `${frame} ${activity}${elapsed}${queued} · Esc interrupt`;
    return displayWidth(full) <= width
      ? full
      : truncateToDisplayWidth(`${frame} ${activity}${elapsed}${queued}`, width);
  }
  return truncateToDisplayWidth(
    state.queued ? `● Ready · ${state.queued} queued` : "● Ready",
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

export const composeStatusSection = (
  state: StatusSectionState,
  requestedWidth: number,
): string[] => {
  const width = normalizedWidth(requestedWidth);
  const now = state.now ?? Date.now();
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";
  const context =
    state.contextSoftLimit === undefined
      ? formatStatusTokens(state.usage.ctx)
      : `${formatStatusTokens(state.usage.ctx)}/${formatStatusTokens(state.contextSoftLimit)}`;
  const controls = "Tab mode · / commands";
  const fullContext = `${state.model} · ctx ${context}`;
  const compactContext = `ctx ${context}`;
  // The controls live on their own line now, so the info line gets the full
  // width. It degrades location → model → context → the essential mode.
  const rootWidth = width - displayWidth(fullContext) - 3;
  const info =
    rootWidth >= 8
      ? `${middleEllipsis(state.root, rootWidth)} · ${fullContext}`
      : displayWidth(fullContext) <= width
        ? fullContext
        : displayWidth(compactContext) <= width
          ? compactContext
          : `${state.mode} · ${compactContext}`;
  const infoLine = truncateToDisplayWidth(info, width);
  const controlsLine = truncateToDisplayWidth(controls, width);

  const jobRows = state.jobs.map((job) => {
    const prefix = `  ${frame} [${job.id}] ${job.mode}: `;
    const suffix = `  ${formatClock(now - job.startedAt)}`;
    const available = width - displayWidth(prefix) - displayWidth(suffix);
    if (available < 0)
      return truncateToDisplayWidth(`${frame} [${job.id}] ${suffix.trim()}`, width);

    const firstLine = job.prompt.split("\n")[0] ?? "";
    const snippet = truncateToDisplayWidth(firstLine, Math.min(48, available));
    return `${prefix}${snippet}${suffix}`;
  });

  return [infoLine, controlsLine, ...jobRows];
};
