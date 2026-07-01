// Long-running-worktree (LRW) re-key. You run agentj inside a dedicated, long-lived git worktree; at
// the start of a task you `/task <ref>` and agentj re-points that worktree at a clean base from origin:
//   - discard everything uncommitted (git reset --hard && git clean -fd),
//   - fetch origin,
//   - re-key onto the target: a PR number → `gh pr checkout`, an existing branch → track origin/<ref>,
//     anything else → a fresh branch off origin/main.
// The whole sequence runs on the host git in the worktree — it's deterministic (not model-driven), so
// the destructive reset never depends on the model choosing to run it correctly.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec.ts";

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").trim();

export interface RekeyResult {
  ok: boolean;
  /** The branch agentj ended up on (when ok). */
  branch?: string;
  /** Human-readable log of the git steps run, for the transcript. */
  steps: string[];
  /** Set when a step failed. */
  error?: string;
}

/**
 * Is `root` a LINKED worktree (not the repo's primary checkout)? A linked worktree's `.git` is a FILE
 * (a `gitdir:` pointer); the primary checkout's `.git` is a directory. Used to gate the destructive
 * `/task` reset so it can't wipe someone's primary checkout by accident.
 */
export async function isLinkedWorktree(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, ".git"))).isFile();
  } catch {
    return false; // no .git (not a repo, or bare) → not a linked worktree
  }
}

/** Classify a `/task` ref: an all-digits ref is a PR number; anything else is a branch name. */
export function classifyRef(ref: string): { kind: "pr" | "branch"; ref: string } {
  return { kind: /^\d+$/.test(ref) ? "pr" : "branch", ref };
}

/**
 * Wipe the worktree, fetch, and re-key onto `ref` — a clean base from origin. Never throws; a failed
 * git step comes back as `{ ok: false, error }` so the caller can report it and stay in the loop.
 */
export async function rekey(root: string, ref: string): Promise<RekeyResult> {
  const steps: string[] = [];
  const git = async (argv: string[], timeoutMs?: number) => {
    const r = await run(argv, { cwd: root, timeoutMs });
    steps.push(argv.join(" ") + (r.exitCode !== 0 ? ` — exit ${r.exitCode}: ${firstLine(r.stderr) || firstLine(r.stdout)}` : ""));
    return r;
  };

  try {
    // 1. Discard everything from the previous task (chosen behavior: hard wipe).
    await git(["git", "reset", "--hard"]);
    await git(["git", "clean", "-fd"]);
    // 2. Sync origin.
    const f = await git(["git", "fetch", "origin"], 60_000);
    if (f.exitCode !== 0) return { ok: false, steps, error: "git fetch origin failed" };

    // 3. Re-key onto the target, from a clean origin base.
    const { kind } = classifyRef(ref);
    if (kind === "pr") {
      const r = await git(["gh", "pr", "checkout", ref], 60_000);
      if (r.exitCode !== 0) return { ok: false, steps, error: `gh pr checkout ${ref} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
      const b = (await run(["git", "branch", "--show-current"], { cwd: root })).stdout.trim();
      return { ok: true, branch: b || ref, steps };
    }
    // Branch: track origin/<ref> if it exists, else start a new branch off origin/main.
    const onOrigin = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}`], { cwd: root })).exitCode === 0;
    const base = onOrigin ? `origin/${ref}` : "origin/main";
    const r = await git(["git", "checkout", "-B", ref, base]);
    if (r.exitCode !== 0) return { ok: false, steps, error: `git checkout -B ${ref} ${base} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
    return { ok: true, branch: ref, steps };
  } catch (err) {
    return { ok: false, steps, error: err instanceof Error ? err.message : String(err) };
  }
}
