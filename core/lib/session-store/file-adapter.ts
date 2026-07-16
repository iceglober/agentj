import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore, StoredAgentSession } from ".";

export function createFileSessionStore(root: string): SessionStore {
  const pathFor = (id: string): string => join(root, id, "manifest.json");
  const write = async (session: StoredAgentSession): Promise<void> => {
    const path = pathFor(session.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(join(root, session.id), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  return {
    create: write,
    save: write,
    async load(id) {
      try {
        return JSON.parse(await readFile(pathFor(id), "utf8")) as StoredAgentSession;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
