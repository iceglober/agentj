// Command runner — runs a command in its own detached process GROUP, so abort/timeout can kill the
// WHOLE tree (bash → turbo → vitest → workers), not just the shell. Without it, killing the shell
// orphans its children, which keep the stdout pipe open and the run hangs until they finish — which
// is why Ctrl-C did nothing mid-command. Does NOT throw on a non-zero exit (that's a normal result
// the model should see); throws only when the process can't be spawned, so callers can fall back.
import { spawn } from "node:child_process";

export interface RunOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Cancels the in-flight process (interrupt / run abort). */
  signal?: AbortSignal;
  /** Wall-clock cap; the process is killed and `timedOut` is set when exceeded. */
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code (or the signal-kill code). */
  exitCode: number;
  /** True iff the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

export function run(argv: string[], opts: RunOptions): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    // `detached` makes the child its own process-GROUP leader; `stdin: ignore` so a command that
    // reads stdin can't hang. We resolve on `close` (process gone), not on draining the pipe.
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d;
    });

    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig); // negative pid → the whole process group
      } catch {
        try {
          child.kill(sig); // group gone already, or no perms — fall back to the direct child
        } catch {
          // already dead
        }
      }
    };
    const timer = opts.timeoutMs != null ? setTimeout(() => ((timedOut = true), killTree("SIGKILL")), opts.timeoutMs) : undefined;
    const onAbort = () => killTree("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) killTree("SIGKILL"); // already aborted before we could listen
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err); // spawn failure (e.g. missing binary) — callers fall back (grep → git grep)
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const exitCode = code ?? (signal === "SIGTERM" ? 143 : 137); // signal-kill → conventional code
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}
