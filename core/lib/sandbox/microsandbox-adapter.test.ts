import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureMicrosandboxBuilder,
  microsandboxOptionsSchema,
  resolveProjectSource,
  runSandboxBootstrap,
} from "./microsandbox-adapter";

type Builder = Parameters<typeof configureMicrosandboxBuilder>[0];

class FakeBuilder {
  readonly calls: string[] = [];
  readonly mounts: Array<{ target: string; source: string }> = [];
  readonly directories: Array<{ path: string; mode: number }> = [];

  image(image: string) {
    this.calls.push(`image:${image}`);
    return this;
  }

  patch(run: (patch: { mkdir(path: string, options: { mode: number }): void }) => void) {
    this.calls.push("patch");
    run({
      mkdir: (directory, options) => this.directories.push({ path: directory, mode: options.mode }),
    });
    return this;
  }

  workdir(workdir: string) {
    this.calls.push(`workdir:${workdir}`);
    return this;
  }

  volume(target: string, run: (mount: { bind(source: string): void }) => void) {
    this.calls.push(`volume:${target}`);
    run({ bind: (source) => this.mounts.push({ target, source }) });
    return this;
  }

  replace() {
    this.calls.push("replace");
    return this;
  }
}

async function runHost(command: string[], cwd?: string) {
  const process = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")}: ${stderr}`);
}

async function withTempGitRepo(run: (repo: string, nested: string) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), "agentj-microsandbox-adapter-test-"));
  const repo = path.join(base, "project");
  const nested = path.join(repo, "nested", "directory");
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repo, "source.txt"), "private fixture contents");
    await runHost(["git", "init", "--quiet", repo]);
    await runHost(["git", "-C", repo, "config", "user.email", "test@example.com"]);
    await runHost(["git", "-C", repo, "config", "user.name", "AgentJ Test"]);
    await runHost(["git", "-C", repo, "add", "source.txt"]);
    await runHost(["git", "-C", repo, "commit", "--quiet", "-m", "fixture"]);
    await run(repo, nested);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}


async function withLinkedWorktree(repo: string, run: (worktree: string) => Promise<void>) {
  const worktree = path.join(path.dirname(repo), "linked-worktree");
  try {
    await runHost(["git", "-C", repo, "worktree", "add", "--detach", worktree, "HEAD"]);
  } catch {
    return;
  }

  try {
    await run(worktree);
  } finally {
    await runHost(["git", "-C", repo, "worktree", "remove", "--force", worktree]).catch(() =>
      rm(worktree, { recursive: true, force: true }),
    );
  }
}

async function fileSnapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.set(path.relative(root, candidate), (await readFile(candidate)).toString("base64"));
    }
  }
  await visit(root);
  return files;
}

async function resolveAndConfigure(builder: FakeBuilder, projectDir: string) {
  const options = microsandboxOptionsSchema.parse({ projectDir });
  const source = await resolveProjectSource(options.projectDir!);
  return configureMicrosandboxBuilder(builder as unknown as Builder, options, source);
}

describe("Microsandbox project-directory configuration", () => {
  test("omits mounts while preserving patch and workdir defaults", () => {
    const builder = new FakeBuilder();
    const options = microsandboxOptionsSchema.parse({});

    configureMicrosandboxBuilder(builder as unknown as Builder, options);

    expect(builder.mounts).toEqual([]);
    expect(builder.calls).toEqual([
      "image:ghcr.io/iceglober/agentj-sandbox-base:1",
      "patch",
      "workdir:/workspace",
      "replace",
    ]);
    expect(builder.directories).toEqual([{ path: "/workspace", mode: 0o755 }]);
  });

  test("binds a regular repository only at its canonical same project path", async () => {
    await withTempGitRepo(async (repo) => {
      const builder = new FakeBuilder();
      const options = microsandboxOptionsSchema.parse({ projectDir: repo });
      const source = await resolveProjectSource(options.projectDir!);
      const canonicalRepo = await realpath(repo);

      configureMicrosandboxBuilder(builder as unknown as Builder, options, source);

      expect(source).toEqual({
        projectRoot: canonicalRepo,
        commonGitDir: await realpath(path.join(repo, ".git")),
      });
      expect(builder.mounts).toEqual([{ target: canonicalRepo, source: canonicalRepo }]);
    });
  });

  test("binds linked worktree and external common Git directory at exact same paths", async () => {
    await withTempGitRepo(async (repo) => {
      await withLinkedWorktree(repo, async (worktree) => {
        const builder = new FakeBuilder();
        const options = microsandboxOptionsSchema.parse({ projectDir: worktree });
        const source = await resolveProjectSource(options.projectDir!);
        const canonicalWorktree = await realpath(worktree);
        const commonGitDir = await realpath(path.join(repo, ".git"));

        configureMicrosandboxBuilder(builder as unknown as Builder, options, source);

        expect(source).toEqual({ projectRoot: canonicalWorktree, commonGitDir });
        expect(builder.mounts).toEqual([
          { target: canonicalWorktree, source: canonicalWorktree },
          { target: commonGitDir, source: commonGitDir },
        ]);
        expect(new Set(builder.mounts.map(({ target }) => target)).size).toBe(builder.mounts.length);
      });
    });
  });

  test("resolves nested input to the Git worktree top-level without changing files", async () => {
    await withTempGitRepo(async (repo, nested) => {
      const before = await fileSnapshot(repo);
      const source = await resolveProjectSource(nested);

      expect(source.projectRoot).toBe(await realpath(repo));
      expect(await fileSnapshot(repo)).toEqual(before);
    });
  });

  test("rejects relative, file, and non-Git paths before mounts and leaves fixtures unchanged", async () => {
    await withTempGitRepo(async (repo) => {
      const builder = new FakeBuilder();
      const before = await fileSnapshot(repo);
      const notDirectory = path.join(repo, "source.txt");
      const nonGitDirectory = path.join(path.dirname(repo), "not-a-repository");
      await mkdir(nonGitDirectory);

      await expect(resolveAndConfigure(builder, "relative/project")).rejects.toThrow("absolute directory");
      await expect(resolveAndConfigure(builder, notDirectory)).rejects.toThrow("not a directory");
      await expect(resolveAndConfigure(builder, nonGitDirectory)).rejects.toThrow("not inside a Git worktree");

      expect(builder.calls).toEqual([]);
      expect(builder.mounts).toEqual([]);
      expect(await fileSnapshot(repo)).toEqual(before);
    });
  });
});

describe("runSandboxBootstrap", () => {
  test("runs configured commands in order", async () => {
    const commands: string[] = [];

    await runSandboxBootstrap({
      async executeCommand(command) {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    }, ["first", "second"]);

    expect(commands).toEqual(["first", "second"]);
  });

  test("stops after the first failed command without exposing command output", async () => {
    const commands: string[] = [];

    await expect(runSandboxBootstrap({
      async executeCommand(command) {
        commands.push(command);
        return { stdout: "secret output", stderr: "secret error", exitCode: command === "bad" ? 7 : 0 };
      },
    }, ["good", "bad", "never"])).rejects.toThrow("command 2 failed with exit code 7");

    expect(commands).toEqual(["good", "bad"]);
  });
});
