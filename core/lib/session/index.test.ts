import { describe, expect, test } from "bun:test";
import type { Sandbox, SandboxCommandResult } from "../sandbox";
import { createChildSession, createSession, sessionConfigSchema } from "./index";

type GitCall = {
  raw: string;
  cwd: string;
  args: string[];
};

interface FakeSandboxOptions {
  readonly childId?: string;
  readonly repoDir?: string;
  readonly root?: string;
  readonly branchPrefix?: string;
  readonly parentRef?: string;
  readonly resolvedParentSha?: string;
  readonly repoHeadSha?: string;
  readonly branchTipSha?: string;
  readonly initialStatus?: string;
  readonly createWorktreeFails?: boolean;
  readonly commitFails?: boolean;
  readonly removeWorktreeFails?: boolean;
  readonly removeWorktreeFailsAfterRemoval?: boolean;
  readonly deleteBranchFails?: boolean;
  readonly postCommitStatus?: string;
  readonly postCommitStatusFails?: boolean;
  readonly postCommitHeadInspectionFails?: boolean;
  readonly committedSha?: string;
  /** For createSession: whether isRepo returns true. */
  readonly isRepo?: boolean;
  /** For createSession: whether hasCommits returns true. */
  readonly hasCommits?: boolean;
}

class FakeSandbox implements Sandbox {
  readonly childId: string;
  readonly repoDir: string;
  readonly root: string;
  readonly branchPrefix: string;
  readonly parentRef: string;
  readonly resolvedParentSha: string;
  readonly repoHeadSha: string;
  readonly committedSha: string;
  readonly postCommitStatus: string;
  readonly calls: GitCall[] = [];

  private readonly createWorktreeFails: boolean;
  private readonly commitFails: boolean;
  private readonly removeWorktreeFails: boolean;
  private readonly removeWorktreeFailsAfterRemoval: boolean;
  private readonly deleteBranchFails: boolean;
  private readonly postCommitStatusFails: boolean;
  private readonly postCommitHeadInspectionFails: boolean;
  private readonly isRepoResult: boolean;
  private readonly hasCommitsResult: boolean;
  private readonly initialBranchTipSha: string;
  private readonly worktrees = new Map<string, { branch: string; head: string }>();
  private readonly branchHeads = new Map<string, string>();
  private readonly statuses = new Map<string, string>();
  private statusCallCount = 0;

  constructor(options: FakeSandboxOptions = {}) {
    this.childId = options.childId ?? "child-1";
    this.repoDir = options.repoDir ?? "/repo";
    this.root = options.root ?? "/workspace";
    this.branchPrefix = options.branchPrefix ?? "session/";
    this.parentRef = options.parentRef ?? "refs/remotes/origin/main";
    this.resolvedParentSha =
      options.resolvedParentSha ?? "1111111111111111111111111111111111111111";
    this.repoHeadSha = options.repoHeadSha ?? this.resolvedParentSha;
    this.initialBranchTipSha = options.branchTipSha ?? this.resolvedParentSha;
    this.committedSha = options.committedSha ?? "2222222222222222222222222222222222222222";
    this.postCommitStatus = options.postCommitStatus ?? "";
    this.createWorktreeFails = options.createWorktreeFails ?? false;
    this.commitFails = options.commitFails ?? false;
    this.removeWorktreeFails = options.removeWorktreeFails ?? false;
    this.removeWorktreeFailsAfterRemoval = options.removeWorktreeFailsAfterRemoval ?? false;
    this.deleteBranchFails = options.deleteBranchFails ?? false;
    this.postCommitStatusFails = options.postCommitStatusFails ?? false;
    this.postCommitHeadInspectionFails = options.postCommitHeadInspectionFails ?? false;
    this.isRepoResult = options.isRepo ?? true;
    this.hasCommitsResult = options.hasCommits ?? true;
    this.statuses.set(this.childPath, options.initialStatus ?? "");
  }

  get childPath(): string {
    return `${this.root}/${this.childId}`;
  }

  get childBranch(): string {
    return `${this.branchPrefix}${this.childId}`;
  }

  get identityCommand(): string {
    return [
      "git config --global user.name 'agentj'",
      "git config --global user.email 'agentj@example.com'",
      "git config --global init.defaultBranch main",
    ].join(" && ");
  }

  async executeCommand(command: string): Promise<SandboxCommandResult> {
    if (command === this.identityCommand) {
      this.calls.push({ raw: command, cwd: "", args: ["config", "--global"] });
      return ok();
    }

    const argv = splitShell(command);
    expect(argv[0]).toBe("git");
    expect(argv[1]).toBe("-C");
    const cwd = argv[2] ?? "";
    const args = argv.slice(3);
    this.calls.push({ raw: command, cwd, args });
    return this.handleGit(cwd, args);
  }

  async readFile(): Promise<string> {
    throw new Error("readFile is not used in session lifecycle tests");
  }

  async writeFiles(): Promise<void> {
    throw new Error("writeFiles is not used in session lifecycle tests");
  }

  private async handleGit(cwd: string, args: string[]): Promise<SandboxCommandResult> {
    const [subcommand, ...rest] = args;

    if (subcommand === "config") {
      return ok();
    }

    if (subcommand === "rev-parse") {
      if (rest[0] === "--is-inside-work-tree") {
        return this.isRepoResult ? ok("true\n") : fail("not a repo");
      }
      if (rest[0] === "--short" && rest[1] === "HEAD") {
        return ok(shortSha(this.headFor(cwd, "HEAD")));
      }
      if (
        cwd === this.repoDir &&
        rest[0] === "-q" &&
        rest[1] === "--verify" &&
        rest[2] === "HEAD" &&
        !this.hasCommitsResult
      ) {
        return fail("no commits");
      }
      const ref = stripCommitSuffix(rest[rest.length - 1] ?? "HEAD");
      if (
        this.postCommitHeadInspectionFails &&
        cwd === this.repoDir &&
        ref === this.childBranch &&
        this.branchHeads.get(this.childBranch) === this.committedSha
      ) {
        return fail("head inspection failed");
      }
      return ok(this.headFor(cwd, ref));
    }

    if (subcommand === "worktree" && rest[0] === "add") {
      expect(cwd).toBe(this.repoDir);
      expect(rest).toEqual(
        expect.arrayContaining(["add", "--no-track", "-b", this.childBranch, this.childPath]),
      );
      expect(rest).toHaveLength(6);
      const baseRef = rest[5];
      expect(baseRef === this.resolvedParentSha || baseRef === "HEAD").toBe(true);
      if (this.createWorktreeFails) return fail("worktree add failed");
      this.worktrees.set(this.childPath, {
        branch: this.childBranch,
        head: baseRef === "HEAD" ? this.repoHeadSha : this.resolvedParentSha,
      });
      this.branchHeads.set(this.childBranch, this.initialBranchTipSha);
      return ok();
    }

    if (subcommand === "worktree" && rest[0] === "list" && rest[1] === "--porcelain") {
      return ok(renderWorktreeList(this.worktrees));
    }

    if (subcommand === "worktree" && rest[0] === "remove") {
      expect(cwd).toBe(this.repoDir);
      expect(rest).toEqual(["remove", "--force", this.childPath]);
      expect(this.worktrees.has(this.childPath)).toBe(true);
      if (this.removeWorktreeFails) return fail("worktree remove failed");
      if (this.removeWorktreeFailsAfterRemoval) {
        this.worktrees.delete(this.childPath);
        return fail("worktree remove failed");
      }
      this.worktrees.delete(this.childPath);
      return ok();
    }

    if (subcommand === "status" && rest[0] === "--porcelain") {
      expect(cwd).toBe(this.childPath);
      this.statusCallCount += 1;
      if (this.postCommitStatusFails && this.statusCallCount === 3) {
        return fail("status failed");
      }
      return ok(this.statuses.get(cwd) ?? "");
    }

    if (subcommand === "add" && rest[0] === "-A") {
      expect(cwd).toBe(this.childPath);
      return ok();
    }

    if (subcommand === "commit" && rest[0] === "-m") {
      expect(cwd).toBe(this.childPath);
      if (this.commitFails) return fail("commit failed");
      const worktree = this.worktrees.get(cwd);
      expect(worktree).toBeDefined();
      worktree!.head = this.committedSha;
      this.branchHeads.set(worktree!.branch, this.committedSha);
      this.statuses.set(cwd, this.postCommitStatus);
      return ok(`[${worktree!.branch} ${shortSha(this.committedSha)}] ${rest[1] ?? "commit"}`);
    }

    if (subcommand === "check-ref-format") {
      expect(cwd).toBe(this.repoDir);
      expect(rest).toEqual(["--branch", this.childBranch]);
      return ok();
    }

    if (subcommand === "branch") {
      expect(cwd).toBe(this.repoDir);
      expect(rest).toEqual(["-D", this.childBranch]);
      if (this.deleteBranchFails) return fail("branch delete failed");
      this.branchHeads.delete(this.childBranch);
      return ok();
    }

    throw new Error(`Unhandled git command: git -C ${cwd} ${args.join(" ")}`);
  }

  private headFor(cwd: string, ref: string): string {
    if (cwd === this.repoDir && ref === this.parentRef) return this.resolvedParentSha;
    if (cwd === this.repoDir && ref === "HEAD") return this.repoHeadSha;
    if (cwd === this.repoDir && ref === this.childBranch)
      return this.branchHeads.get(this.childBranch) ?? this.resolvedParentSha;
    if (cwd === this.repoDir && /^[0-9a-f]{40}$/i.test(ref)) return ref;
    if (cwd === this.childPath && ref === "HEAD")
      return this.worktrees.get(this.childPath)?.head ?? this.committedSha;
    throw new Error(`Unhandled rev-parse target: cwd=${cwd} ref=${ref}`);
  }
}

function ok(stdout = ""): SandboxCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string): SandboxCommandResult {
  return { stdout: "", stderr, exitCode: 1 };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function stripCommitSuffix(ref: string): string {
  return ref.replace(/\^\{commit\}$/, "");
}

function renderWorktreeList(worktrees: Map<string, { branch: string; head: string }>): string {
  return [...worktrees.entries()]
    .map(([path, worktree]) => {
      return [
        `worktree ${path}`,
        `HEAD ${worktree.head}`,
        `branch refs/heads/${worktree.branch}`,
        "",
      ].join("\n");
    })
    .join("\n");
}

function splitShell(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        current += command[i]!;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      i += 1;
      current += command[i]!;
      continue;
    }
    current += char;
  }

  if (quote) throw new Error(`Unclosed quote in command: ${command}`);
  if (current !== "") parts.push(current);
  return parts;
}

function makeConfig(sb: FakeSandbox) {
  return sessionConfigSchema.parse({
    repoDir: sb.repoDir,
    root: sb.root,
    branchPrefix: sb.branchPrefix,
    identity: { name: "agentj", email: "agentj@example.com" },
  });
}

async function makeChildSession(options: FakeSandboxOptions = {}) {
  const sb = new FakeSandbox(options);
  const session = await createChildSession(sb, makeConfig(sb), {
    id: sb.childId,
    parentRef: sb.parentRef,
  });
  return { sb, session };
}

function matchingCalls(sb: FakeSandbox, predicate: (call: GitCall) => boolean): GitCall[] {
  return sb.calls.filter(predicate);
}

describe("createSession", () => {
  test("caller-supplied id with a separator still uses historical path and branch and reaches addWorktree", async () => {
    const id = "feature/foo";
    const sb = new FakeSandbox({ childId: id });
    const config = sessionConfigSchema.parse({
      repoDir: sb.repoDir,
      root: sb.root,
      branchPrefix: sb.branchPrefix,
      base: "head",
      identity: { name: "agentj", email: "agentj@example.com" },
    });

    const session = await createSession(sb, config, id);

    expect(session.id).toBe(id);
    expect(session.path).toBe(`${sb.root}/${id}`);
    expect(session.branch).toBe(`${sb.branchPrefix}${id}`);
    expect(session.base).toBe("HEAD");

    const addWorktree = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "add",
    );
    expect(addWorktree).toHaveLength(1);
    expect(addWorktree[0]?.raw).toBe(
      `git -C '${sb.repoDir}' 'worktree' 'add' '--no-track' '-b' '${sb.branchPrefix}${id}' '${sb.root}/${id}' 'HEAD'`,
    );
    expect(addWorktree[0]?.args).toEqual([
      "worktree",
      "add",
      "--no-track",
      "-b",
      `${sb.branchPrefix}${id}`,
      `${sb.root}/${id}`,
      "HEAD",
    ]);

    await session.dispose();

    const removeCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "remove",
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.args).toEqual(["worktree", "remove", "--force", `${sb.root}/${id}`]);
  });
});

describe("createChildSession", () => {
  test("explicit parent ref resolves once to immutable SHA and addWorktree uses that SHA", async () => {
    const { sb, session } = await makeChildSession();

    expect(sb.calls[1]?.raw).toBe(sb.identityCommand);
    expect(session.parentRef).toBe(sb.parentRef);
    expect(session.base).toBe(sb.resolvedParentSha);

    const parentRefResolutions = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.repoDir &&
        call.args[0] === "rev-parse" &&
        call.args[call.args.length - 1] === `${sb.parentRef}^{commit}`,
    );
    expect(parentRefResolutions).toHaveLength(1);

    const addWorktree = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "add",
    );
    expect(addWorktree).toHaveLength(1);
    expect(addWorktree[0]?.raw).toBe(
      `git -C '${sb.repoDir}' 'worktree' 'add' '--no-track' '-b' '${sb.childBranch}' '${sb.childPath}' '${sb.resolvedParentSha}'`,
    );
    expect(addWorktree[0]?.args).toEqual([
      "worktree",
      "add",
      "--no-track",
      "-b",
      sb.childBranch,
      sb.childPath,
      sb.resolvedParentSha,
    ]);
  });

  test("clean success removes the child worktree, proof-checks exact tip/base, then force deletes its branch", async () => {
    const { sb, session } = await makeChildSession();

    const result = await session.finalize({ outcome: "success", commitMessage: "unused" });

    expect(result).toEqual({
      outcome: "clean",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.resolvedParentSha,
      status: "",
      commit: null,
      worktreeRemoved: true,
      branchDeleted: true,
      preserved: false,
    });

    const destructive = sb.calls.filter(
      (call) =>
        (call.args[0] === "worktree" && call.args[1] === "remove") ||
        call.args[0] === "check-ref-format" ||
        (call.args[0] === "rev-parse" &&
          [`${sb.childBranch}^{commit}`, `${sb.resolvedParentSha}^{commit}`].includes(
            call.args[call.args.length - 1] ?? "",
          )) ||
        call.args[0] === "branch",
    );
    expect(destructive.map((call) => call.args)).toEqual([
      ["worktree", "remove", "--force", sb.childPath],
      ["check-ref-format", "--branch", sb.childBranch],
      ["rev-parse", "-q", "--verify", `${sb.childBranch}^{commit}`],
      ["rev-parse", "-q", "--verify", `${sb.resolvedParentSha}^{commit}`],
      ["branch", "-D", sb.childBranch],
    ]);
    expect(destructive.map((call) => call.raw)).toEqual([
      `git -C '${sb.repoDir}' 'worktree' 'remove' '--force' '${sb.childPath}'`,
      `git -C '${sb.repoDir}' 'check-ref-format' '--branch' '${sb.childBranch}'`,
      `git -C '${sb.repoDir}' 'rev-parse' '-q' '--verify' '${sb.childBranch}^{commit}'`,
      `git -C '${sb.repoDir}' 'rev-parse' '-q' '--verify' '${sb.resolvedParentSha}^{commit}'`,
      `git -C '${sb.repoDir}' 'branch' '-D' '${sb.childBranch}'`,
    ]);
    expect(
      destructive.every((call) => {
        const target = call.args[call.args.length - 1];
        return (
          target === sb.childPath ||
          target === sb.childBranch ||
          target === `${sb.childBranch}^{commit}` ||
          target === `${sb.resolvedParentSha}^{commit}`
        );
      }),
    ).toBe(true);
  });

  test("clean success deletes even when repo HEAD diverged because proof checks exact branch tip and base", async () => {
    const repoHeadSha = "9999999999999999999999999999999999999999";
    const { sb, session } = await makeChildSession({ repoHeadSha });

    const result = await session.finalize({ outcome: "success", commitMessage: "unused" });

    expect(result.outcome).toBe("clean");
    expect(sb.repoHeadSha).toBe(repoHeadSha);

    const repoRevParseCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "rev-parse",
    );
    expect(repoRevParseCalls.map((call) => call.args)).toEqual([
      ["rev-parse", "-q", "--verify", `${sb.parentRef}^{commit}`],
      ["rev-parse", "-q", "--verify", `${sb.childBranch}^{commit}`],
      ["rev-parse", "-q", "--verify", `${sb.resolvedParentSha}^{commit}`],
    ]);
    expect(
      repoRevParseCalls.some(
        (call) =>
          call.args[call.args.length - 1] === "HEAD" ||
          call.args[call.args.length - 1] === "HEAD^{commit}",
      ),
    ).toBe(false);
  });

  test("changed success captures dirty status, commits, verifies clean, removes worktree, keeps branch, and returns commit metadata", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts\n?? new.txt",
    });

    const result = await session.finalize({ outcome: "success", commitMessage: "child commit" });

    expect(result).toEqual({
      outcome: "changed",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: " M src/index.ts\n?? new.txt",
      commit: sb.committedSha,
      worktreeRemoved: true,
      branchDeleted: false,
      preserved: false,
    });

    expect(
      sb.calls
        .map((call) => ({ cwd: call.cwd, args: call.args }))
        .filter((call) => call.cwd === sb.childPath || call.cwd === sb.repoDir),
    ).toContainEqual({ cwd: sb.childPath, args: ["add", "-A"] });
    expect(sb.calls).toContainEqual({
      raw: expect.any(String),
      cwd: sb.childPath,
      args: ["commit", "-m", "child commit"],
    });

    const statusCalls = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.childPath && call.args[0] === "status" && call.args[1] === "--porcelain",
    );
    expect(statusCalls).toHaveLength(3);

    const branchDeleteCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "branch",
    );
    expect(branchDeleteCalls).toHaveLength(0);
    const removeCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "remove",
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.raw).toBe(
      `git -C '${sb.repoDir}' 'worktree' 'remove' '--force' '${sb.childPath}'`,
    );
    expect(removeCalls[0]?.args).toEqual(["worktree", "remove", "--force", sb.childPath]);
  });

  test("changed lane commit failure preserves known dirty evidence and never tries later cleanup", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      commitFails: true,
    });

    await expect(
      session.finalize({ outcome: "success", commitMessage: "child commit" }),
    ).resolves.toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.resolvedParentSha,
      status: " M src/index.ts",
      commit: null,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail: "git commit -m child commit exited 1: commit failed",
    });

    const laterDestructiveCalls = matchingCalls(
      sb,
      (call) =>
        (call.args[0] === "worktree" && call.args[1] === "remove") ||
        call.args[0] === "check-ref-format" ||
        call.args[0] === "branch",
    );
    expect(laterDestructiveCalls).toHaveLength(0);
  });

  test("changed lane post-commit status failure preserves committed head and skips later branch deletion", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      postCommitStatusFails: true,
    });

    await expect(
      session.finalize({ outcome: "success", commitMessage: "child commit" }),
    ).resolves.toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: "",
      commit: shortSha(sb.committedSha),
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail: "git status --porcelain exited 1: status failed",
    });

    const laterDestructiveCalls = matchingCalls(
      sb,
      (call) =>
        (call.args[0] === "worktree" && call.args[1] === "remove") ||
        call.args[0] === "check-ref-format" ||
        call.args[0] === "branch",
    );
    expect(laterDestructiveCalls).toHaveLength(0);
  });

  test("changed lane post-commit head inspection failure preserves committed evidence and skips later branch deletion", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      postCommitHeadInspectionFails: true,
    });

    await expect(
      session.finalize({ outcome: "success", commitMessage: "child commit" }),
    ).resolves.toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: "",
      commit: sb.committedSha,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail: `git rev-parse -q --verify ${sb.childBranch}^{commit} exited 1: head inspection failed`,
    });

    const laterDestructiveCalls = matchingCalls(
      sb,
      (call) =>
        (call.args[0] === "worktree" && call.args[1] === "remove") ||
        call.args[0] === "check-ref-format" ||
        call.args[0] === "branch",
    );
    expect(laterDestructiveCalls).toHaveLength(0);
  });

  test("changed lane remove failure with worktree still present preserves that uncertainty and skips branch deletion", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      removeWorktreeFails: true,
    });

    await expect(
      session.finalize({ outcome: "success", commitMessage: "child commit" }),
    ).resolves.toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: "",
      commit: sb.committedSha,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail: `git worktree remove --force ${sb.childPath} exited 1: worktree remove failed`,
    });

    const branchDeleteCalls = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.repoDir &&
        (call.args[0] === "check-ref-format" || call.args[0] === "branch"),
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });

  test("changed lane remove error can still report worktreeRemoved when inspection proves it gone", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      removeWorktreeFailsAfterRemoval: true,
    });

    await expect(
      session.finalize({ outcome: "success", commitMessage: "child commit" }),
    ).resolves.toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: "",
      commit: sb.committedSha,
      worktreeRemoved: true,
      branchDeleted: false,
      preserved: true,
      detail: `git worktree remove --force ${sb.childPath} exited 1: worktree remove failed`,
    });

    const branchDeleteCalls = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.repoDir &&
        (call.args[0] === "check-ref-format" || call.args[0] === "branch"),
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });

  test.each([
    { outcome: "failure", detail: "test failed" },
    { outcome: "aborted", detail: "user cancelled" },
  ] as const)("$outcome preserves path and branch and issues no remove/delete commands", async ({
    outcome,
    detail,
  }) => {
    const { sb, session } = await makeChildSession({ initialStatus: " M kept.txt" });

    const result = await session.finalize({ outcome, detail });

    expect(result).toEqual({
      outcome: "preserved",
      reason: outcome,
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.resolvedParentSha,
      status: " M kept.txt",
      commit: null,
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail,
    });

    const destructive = matchingCalls(
      sb,
      (call) =>
        call.args[0] === "worktree" ||
        call.args[0] === "branch" ||
        call.args[0] === "check-ref-format",
    ).filter((call) => call.args[1] !== "add" && call.args[1] !== "list");
    expect(destructive).toHaveLength(0);
  });

  test("commit/post-commit uncertainty preserves instead of deleting", async () => {
    const { sb, session } = await makeChildSession({
      initialStatus: " M src/index.ts",
      postCommitStatus: " M src/index.ts",
    });

    const result = await session.finalize({ outcome: "success", commitMessage: "child commit" });

    expect(result).toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.committedSha,
      status: " M src/index.ts",
      commit: shortSha(sb.committedSha),
      worktreeRemoved: false,
      branchDeleted: false,
      preserved: true,
      detail: "child worktree remained dirty after commit",
    });

    const destructive = matchingCalls(
      sb,
      (call) =>
        call.args[0] === "worktree" ||
        call.args[0] === "branch" ||
        call.args[0] === "check-ref-format",
    ).filter((call) => call.args[1] !== "add" && call.args[1] !== "list");
    expect(destructive).toHaveLength(0);
  });

  test("branch tip mismatch yields preserved uncertain state and skips force deletion", async () => {
    const branchTipSha = "3333333333333333333333333333333333333333";
    const { sb, session } = await makeChildSession({ branchTipSha });

    const result = await session.finalize({ outcome: "success", commitMessage: "unused" });

    expect(result).toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.resolvedParentSha,
      status: "",
      commit: null,
      worktreeRemoved: true,
      branchDeleted: false,
      preserved: true,
      detail: `Refusing to delete disposable branch ${sb.childBranch}: expected ${sb.resolvedParentSha}, found ${branchTipSha}`,
    });

    const branchDeleteCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "branch",
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });

  test("delete failure after worktree removal still reports worktreeRemoved accurately", async () => {
    const { sb, session } = await makeChildSession({ deleteBranchFails: true });

    const result = await session.finalize({ outcome: "success", commitMessage: "unused" });

    expect(result).toEqual({
      outcome: "preserved",
      reason: "uncertain",
      id: sb.childId,
      path: sb.childPath,
      branch: sb.childBranch,
      base: sb.resolvedParentSha,
      parentRef: sb.parentRef,
      head: sb.resolvedParentSha,
      status: "",
      commit: null,
      worktreeRemoved: true,
      branchDeleted: false,
      preserved: true,
      detail: `git branch -D ${sb.childBranch} exited 1: branch delete failed`,
    });
  });

  test("repeated finalize/dispose returns cached terminal result without duplicate destructive commands", async () => {
    const { sb, session } = await makeChildSession();

    const first = await session.finalize({ outcome: "success", commitMessage: "unused" });
    const second = await session.finalize({ outcome: "success", commitMessage: "ignored" });
    await session.dispose();
    await session.dispose();

    expect(second).toBe(first);

    const removeCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "remove",
    );
    const branchProofCalls = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.repoDir &&
        call.args[0] === "rev-parse" &&
        call.args[call.args.length - 1] === `${sb.childBranch}^{commit}`,
    );
    const baseProofCalls = matchingCalls(
      sb,
      (call) =>
        call.cwd === sb.repoDir &&
        call.args[0] === "rev-parse" &&
        call.args[call.args.length - 1] === `${sb.resolvedParentSha}^{commit}`,
    );
    const branchDeleteCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "branch" && call.args[1] === "-D",
    );
    expect(removeCalls).toHaveLength(1);
    expect(branchProofCalls).toHaveLength(1);
    expect(baseProofCalls).toHaveLength(1);
    expect(branchDeleteCalls).toHaveLength(1);
  });

  test.each([
    "child-1",
    "Child_2",
    "3.4",
    "z",
    "A_B-c.9",
    "task.1",
    "v1.2.3",
    "a.b",
    "my.task.name",
  ])("accepts valid child id %s before creating the worktree", async (childId) => {
    const { sb, session } = await makeChildSession({ childId });

    expect(session.id).toBe(childId);
    expect(session.branch).toBe(`${sb.branchPrefix}${childId}`);
    expect(session.path).toBe(`${sb.root}/${childId}`);
  });

  test.each([
    "../sibling",
    "child/one",
    "child\\one",
    "child one",
    "-child",
    ".",
    "..",
    "a..b",
    "task.",
    "task.lock",
    "head",
    "HeAd",
    "HEAD",
    "a".repeat(65),
  ])("rejects invalid child id %s before issuing any git commands", async (childId) => {
    const sb = new FakeSandbox({ childId });

    await expect(
      createChildSession(sb, makeConfig(sb), { id: childId, parentRef: sb.parentRef }),
    ).rejects.toThrow();
    expect(sb.calls).toHaveLength(0);
  });

  test("creation failure rejects without pretending a session exists", async () => {
    const sb = new FakeSandbox({ createWorktreeFails: true });

    await expect(
      createChildSession(sb, makeConfig(sb), { id: sb.childId, parentRef: sb.parentRef }),
    ).rejects.toThrow("worktree add failed");

    const addCalls = matchingCalls(
      sb,
      (call) => call.cwd === sb.repoDir && call.args[0] === "worktree" && call.args[1] === "add",
    );
    const destructive = matchingCalls(
      sb,
      (call) =>
        call.args[0] === "worktree" ||
        call.args[0] === "branch" ||
        call.args[0] === "check-ref-format",
    ).filter((call) => call.args[1] !== "add");
    expect(addCalls).toHaveLength(1);
    expect(destructive).toHaveLength(0);
  });
});
