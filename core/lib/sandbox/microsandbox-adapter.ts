import type { Sandbox } from "./index";
import { Sandbox as Microsandbox } from "microsandbox";

/** Maps to future config keys `sandbox.{image,workdir,...}`. */
export interface MicrosandboxProviderOptions {
  name?: string;
  /** OCI image reference, Docker-style (e.g. "python", "ubuntu:24.04"). */
  image?: string;
  /** Created via rootfs patch before boot; commands run here. */
  workdir?: string;
}

export const createSandboxProviderMicrosandbox = ({
  name = "worker",
  image = "python",
  workdir = "/workspace",
}: MicrosandboxProviderOptions = {}) =>
  async (): Promise<Sandbox & AsyncDisposable> => {
    const sb = await Microsandbox.builder(name)
      .image(image)
      .patch((p) => p.mkdir(workdir, { mode: 0o755 }))
      .workdir(workdir)
      .replace()
      .create();
    return {
      async executeCommand(command) {
        const r = await sb.shell(command);
        return { stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code };
      },
      async readFile(path) {
        return sb.fs().readToString(path);
      },
      async writeFiles(files) {
        for (const file of files) {
          const dir = file.path.split("/").slice(0, -1).join("/");
          if (dir) await sb.shell(`mkdir -p '${dir.replaceAll("'", "'\\''")}'`);
          await sb.fs().write(file.path, file.content);
        }
      },
      [Symbol.asyncDispose]: () => sb[Symbol.asyncDispose](),
    };
  };
