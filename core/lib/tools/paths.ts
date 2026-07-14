import { posix as path } from "node:path";
import type { Sandbox } from "../sandbox";

const ROOT_PATH = "/";

const normalizeRoot = (root: string): string => {
  if (!root.trim()) {
    throw new Error("Sandbox root must be a non-empty POSIX path.");
  }

  const normalizedRoot = path.normalize(root);

  if (!path.isAbsolute(normalizedRoot)) {
    throw new Error(`Sandbox root must be an absolute POSIX path: ${root}`);
  }

  return normalizedRoot;
};

const isWithinRoot = (root: string, candidate: string): boolean =>
  root === ROOT_PATH || candidate === root || candidate.startsWith(`${root}/`);

export const resolveWithinRoot = (root: string, candidate?: string): string => {
  const normalizedRoot = normalizeRoot(root);

  if (!candidate?.trim()) {
    return normalizedRoot;
  }

  const normalizedCandidate = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(normalizedRoot, candidate);

  if (!isWithinRoot(normalizedRoot, normalizedCandidate)) {
    throw new Error(`Path escapes sandbox root: ${candidate} is outside ${normalizedRoot}`);
  }

  return normalizedCandidate;
};

export const confineSandboxFiles = (sb: Sandbox, root: string): Sandbox => ({
  executeCommand: sb.executeCommand.bind(sb),
  readFile: (candidate) => sb.readFile(resolveWithinRoot(root, candidate)),
  writeFiles: (files) =>
    sb.writeFiles(
      files.map(({ path: candidate, content }) => ({
        path: resolveWithinRoot(root, candidate),
        content,
      })),
    ),
});
