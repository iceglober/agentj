import type { Env, FixtureFactory, FixtureRef } from "../../lib/eval/types";
import type { Sandbox } from "../../lib/sandbox";
import * as scm from "../../lib/scm/git";
import { shq } from "../../lib/shell";

const FIXTURE_IDENTITY = { name: "agentj-eval", email: "eval@sandbox.local" };

// Build artifacts a run legitimately produces but that must not count as
// "changed files" — otherwise diff_scope flags e.g. __pycache__ from any
// `python3 tests.py`. Committed into the baseline (unless the fixture ships its
// own .gitignore) so git-based diff/changedFiles never surface them.
const DEFAULT_GITIGNORE = "__pycache__/\n*.pyc\n.pytest_cache/\n";
const hasGitignore = (files: { path: string }[]) =>
  files.some((f) => f.path === ".gitignore" || f.path.endsWith("/.gitignore"));

const randomId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

/** Collect {path, content} pairs from a fixture ref (host dir read for `dir`). */
async function collectFiles(ref: FixtureRef): Promise<{ path: string; content: string }[]> {
  if (ref.kind === "inline")
    return Object.entries(ref.files).map(([path, content]) => ({ path, content }));
  // dir: read the host directory tree via Bun.Glob.
  const files: { path: string; content: string }[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: ref.path, onlyFiles: true, dot: true })) {
    files.push({ path: rel, content: await Bun.file(`${ref.path}/${rel}`).text() });
  }
  return files;
}

/**
 * A FixtureFactory backed by a Sandbox VM: every trial gets a fresh directory
 * under `root`, seeded with the fixture files and committed as a git baseline so
 * `diff()`/`changedFiles()` measure exactly what the agent changed. Envs are
 * disposable — `destroy()` (and asyncDispose) just remove the directory.
 */
export function createSandboxFixtureFactory(sb: Sandbox, opts: { root: string }): FixtureFactory {
  return {
    async make(ref: FixtureRef): Promise<Env> {
      const id = randomId();
      const dir = `${opts.root}/${id}`;
      const resolve = (p: string) => (p.startsWith("/") ? p : `${dir}/${p}`);
      const write = (files: { path: string; content: string }[]) =>
        sb.writeFiles(files.map((f) => ({ path: resolve(f.path), content: f.content })));

      await sb.executeCommand(`rm -rf ${shq(dir)} && mkdir -p ${shq(dir)}`);
      const files = await collectFiles(ref);
      await write(
        hasGitignore(files)
          ? files
          : [{ path: ".gitignore", content: DEFAULT_GITIGNORE }, ...files],
      );

      await scm.ensureIdentity(sb, FIXTURE_IDENTITY);
      const init = await sb.executeCommand(
        `cd ${shq(dir)} && git init -q && git add -A && git commit -qm fixture`,
      );
      if (init.exitCode !== 0)
        throw new Error(`fixture baseline commit failed: ${init.stderr || init.stdout}`);

      const destroy = async () => {
        await sb.executeCommand(`rm -rf ${shq(dir)}`);
      };

      return {
        id,
        dir,
        exec: (command) => sb.executeCommand(`cd ${shq(dir)} && ${command}`),
        writeFiles: (files) => write(files),
        diff: () => scm.diff(sb, dir),
        async changedFiles() {
          await scm.git(sb, dir, ["add", "-A"]);
          const out = await scm.git(sb, dir, ["diff", "--cached", "--name-only", "HEAD"]);
          return out
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        },
        destroy,
        [Symbol.asyncDispose]: destroy,
      };
    },
  };
}
