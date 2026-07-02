// Structured JSON-lines logger. Each service keeps its recent lines in memory and serves them at
// GET /__logs, so tests and operators can inspect a running instance without tailing files.
export interface Logger {
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  lines: string[];
}

export function makeLogger(service: string): Logger {
  const lines: string[] = [];
  return {
    lines,
    log(level, msg, fields = {}) {
      const line = JSON.stringify({ ts: new Date().toISOString(), service, level, msg, ...fields });
      lines.push(line);
      if (lines.length > 500) lines.shift();
    },
  };
}
