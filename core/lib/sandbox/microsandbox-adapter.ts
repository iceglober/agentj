import z from "zod";
import type { Sandbox } from "./index";
import { Sandbox as Microsandbox } from "microsandbox";

/** The `sandbox.*` section of the agent config. */
export const microsandboxOptionsSchema = z.object({
  name: z.string().default("worker"),
  /** OCI image reference, Docker-style (e.g. "python", "ubuntu:24.04"). */
  image: z.string().default("python"),
  /** Created via rootfs patch before boot; commands run here. */
  workdir: z.string().default("/workspace"),
});

export type MicrosandboxProviderOptions = z.input<
  typeof microsandboxOptionsSchema
>;

export const createSandboxProviderMicrosandbox = (
  options: MicrosandboxProviderOptions = {},
) =>
  async (): Promise<Sandbox & AsyncDisposable> => {
    const { name, image, workdir } = microsandboxOptionsSchema.parse(options);
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
