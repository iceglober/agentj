import { shq } from "../shell";
import type { ExecutionEnvironment } from ".";
import type { ProjectFileSource } from "./project-files";

/** Git-backed adapter: tracked and unignored working-tree files, relative to the project root. */
export const createGitProjectFileSource = (
  environment: Pick<ExecutionEnvironment, "executeCommand">,
  root: string,
): ProjectFileSource => ({
  async listFiles() {
    const result = await environment.executeCommand(
      `git -C ${shq(root)} ls-files --cached --others --exclude-standard -z`,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\0").filter(Boolean);
  },
});
