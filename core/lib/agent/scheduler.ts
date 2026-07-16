export interface ScheduleTasksOptions<Task, Result> {
  tasks: readonly Task[];
  concurrency: number;
  abortSignal?: AbortSignal;
  id(task: Task): string;
  dependencies(task: Task): readonly string[];
  run(task: Task, completed: ReadonlyMap<string, Result>): Promise<Result>;
  dependencySucceeded(result: Result): boolean;
  blocked(task: Task, failedDependencies: readonly string[]): Promise<Result> | Result;
  abortedBeforeStart?(task: Task): Promise<Result> | Result;
}

/** Run a bounded dependency graph while preserving the caller's input order. */
export async function scheduleTasks<Task, Result>(
  options: ScheduleTasksOptions<Task, Result>,
): Promise<Result[]> {
  const tasks = [...options.tasks];
  const pending = new Map(tasks.map((task) => [options.id(task), task]));
  const completed = new Map<string, Result>();
  const running = new Map<string, Promise<void>>();
  const concurrency = Math.max(1, Math.min(options.concurrency, tasks.length));

  const start = (task: Task): void => {
    const id = options.id(task);
    const promise = options
      .run(task, completed)
      .then((result) => {
        completed.set(id, result);
      })
      .finally(() => running.delete(id));
    running.set(id, promise);
  };

  while (pending.size > 0 || running.size > 0) {
    let advanced = false;
    for (const [id, task] of pending) {
      if (running.size >= concurrency) break;
      const dependencies = options.dependencies(task);
      const dependencyResults = dependencies.map((dependency) => completed.get(dependency));
      if (
        dependencyResults.some(
          (result) => result !== undefined && !options.dependencySucceeded(result),
        )
      ) {
        if (dependencyResults.every((result) => result !== undefined)) {
          pending.delete(id);
          completed.set(
            id,
            await options.blocked(
              task,
              dependencies.filter(
                (dependency) => !options.dependencySucceeded(completed.get(dependency)!),
              ),
            ),
          );
          advanced = true;
        }
        continue;
      }
      if (dependencies.length === 0 || dependencyResults.every((result) => result !== undefined)) {
        if (options.abortSignal?.aborted) break;
        pending.delete(id);
        start(task);
        advanced = true;
      }
    }

    if (running.size > 0) {
      await Promise.race(running.values());
      continue;
    }
    if (options.abortSignal?.aborted && options.abortedBeforeStart) {
      for (const [id, task] of pending) {
        pending.delete(id);
        completed.set(id, await options.abortedBeforeStart(task));
      }
      continue;
    }
    if (!advanced && pending.size > 0) throw new Error("Subagent task graph stalled");
  }

  return tasks.map((task) => completed.get(options.id(task))!);
}
