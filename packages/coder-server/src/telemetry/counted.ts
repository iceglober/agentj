// Counted (counted.dev) — privacy-first product analytics for feature-level events
// (commands run, det proposals accepted/rejected, jobs, provider mix, succinctness
// setting). Opt-out; **never code or prompt contents** (PLAN R12, N8).

export interface AnalyticsEvent {
  name: string;
  /** Enum/flag properties only — never code or prompt text. */
  props?: Record<string, string | number | boolean>;
}

export interface Analytics {
  track(event: AnalyticsEvent): void;
  flush(): Promise<void>;
}

/** No-op analytics; active when DO_NOT_TRACK / *_NO_ANALYTICS is set or unconfigured. */
export const noopAnalytics: Analytics = {
  track: () => {},
  flush: async () => {},
};

export function analyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DO_NOT_TRACK !== "1" && env.CODER_NO_ANALYTICS !== "1";
}

// TODO(P1): wire @counted/sdk; flush on beforeExit (glrs analytics.ts pattern, clean).
export function createAnalytics(env: NodeJS.ProcessEnv = process.env): Analytics {
  return analyticsEnabled(env) ? noopAnalytics : noopAnalytics;
}
