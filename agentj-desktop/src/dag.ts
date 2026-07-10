// Parse a `run_subagents` tool call's JSON args into its task DAG. The args already carry each task's
// title/type and its `after` dependencies, so the visualization needs no extra backend event.

export interface DagTask {
  title: string;
  type: string;
  after: number[];
}

export interface Dag {
  tasks: DagTask[];
  stages: number[]; // topological depth per task (0 = runs first)
}

export function parseDag(argsJson: string): Dag | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  const raw = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const tasks: DagTask[] = raw.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const title = String(o.title || o.task || `task ${i + 1}`);
    return {
      title: title.length > 60 ? title.slice(0, 59) + "…" : title,
      type: String(o.type || "executor"),
      after: Array.isArray(o.after)
        ? o.after.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < raw.length)
        : [],
    };
  });
  return { tasks, stages: stageLevels(tasks) };
}

// Memoized DFS depth: 0 with no deps, else 1 + max(dep depth). Cycles resolve to 0 (defensive; the
// backend rejects real cycles before we ever see them).
function stageLevels(tasks: DagTask[]): number[] {
  const memo = new Array<number>(tasks.length).fill(-1);
  const onStack = new Array<boolean>(tasks.length).fill(false);
  const depth = (i: number): number => {
    if (memo[i] >= 0) return memo[i];
    if (onStack[i]) return 0;
    onStack[i] = true;
    let d = 0;
    for (const dep of tasks[i].after) d = Math.max(d, depth(dep) + 1);
    onStack[i] = false;
    memo[i] = d;
    return d;
  };
  return tasks.map((_, i) => depth(i));
}
