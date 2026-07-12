import type { Sandbox } from "./index";
import { Sandbox as Microsandbox } from "microsandbox";

export const createSandboxProviderMicrosandbox =
  (name = "worker") =>
  async (): Promise<Sandbox & AsyncDisposable> => {
    const sb = await Microsandbox.builder(name).image("python").replace().create();
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
