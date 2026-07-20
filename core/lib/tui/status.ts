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

const fitsTogether = (left: string, right: string, width: number): boolean =>
  displayWidth(left) + displayWidth(right) + 2 <= width;

/** Left and right hug opposite edges once both fit with a readable gap. */
const splitEnds = (left: string, right: string, width: number): string => {
  if (right.length === 0) return truncateToDisplayWidth(left, width);
  const gap = width - displayWidth(left) - displayWidth(right);
  if (gap >= 2) return `${left}${" ".repeat(gap)}${right}`;
  return truncateToDisplayWidth(`${left} ${right}`, width);
};

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
  const activity = state.interruptRequested ? "interrupting…" : "thinking";
  const full = `${frame} ${activity}${elapsed}${state.interruptRequested ? "" : " (esc)"}`;
  if (displayWidth(full) <= width) return full;
  return truncateToDisplayWidth(`${frame} ${activity}${elapsed}`, width);
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
  // Dropped in compact layouts — width wins there.
  const cacheRead = state.usage.cacheRead;
  const cached =
    cacheRead === undefined || state.usage.in <= 0
      ? ""
      : ` · cached ${formatStatusTokens(cacheRead)}(${Math.round((cacheRead / state.usage.in) * 100)}%)`;
  const labeled = `in ${counters[0]}${cached} ▸ out ${counters[1]} · ctx ${counters[2]} · ${clock}`;
  const compact = `${counters[0]}▸${counters[1]}·${counters[2]}·${clock}`;
  const essential = `ctx ${counters[2]} · ${clock}`;
  const identities = [
    `${state.sessionId} · ${state.model} · ${state.mode} (tab↕)`,
    `${state.sessionId} · ${state.mode} (tab↕)`,
    `${state.mode} (tab↕)`,
  ] as const;
  const variants = [
    [identities[0], labeled],
    [identities[1], labeled],
    [identities[1], compact],
    [identities[2], essential],
  ] as const;
  const identity = variants.find(([left, right]) => fitsTogether(left, right, width));
  const identityLine = identity
    ? splitEnds(identity[0], identity[1], width)
    : truncateToDisplayWidth(`${identities[2]} · ${essential}`, width);

  const version = `aj ${state.version}`;
  const versionWidth = displayWidth(version);
  const rootWidth = width - versionWidth - 2;
  const location =
    versionWidth > width
      ? truncateToDisplayWidth(version, width)
      : rootWidth < 1
        ? version
        : splitEnds(middleEllipsis(state.root, rootWidth), version, width);

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

  return [identityLine, location, ...jobRows];
};
