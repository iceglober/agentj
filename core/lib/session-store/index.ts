export type StoredSessionPhase =
  | "preparing"
  | "planning"
  | "awaiting-feedback"
  | "building"
  | "completed"
  | "blocked"
  | "aborted";

export interface StoredAgentSession {
  id: string;
  version: number;
  projectRoot: string;
  workspaceMode: "local" | "sandbox";
  sandboxProvider?: string;
  task: string;
  phase: StoredSessionPhase;
  plan: string | null;
  planRevision: number;
  feedback: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  create(session: StoredAgentSession): Promise<void>;
  load(id: string): Promise<StoredAgentSession | null>;
  save(session: StoredAgentSession): Promise<void>;
}
