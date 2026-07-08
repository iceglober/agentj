// Multi-session bridge to the Tauri backend. All backend contact lives here:
// it subscribes to the tagged event streams and exposes the session commands.
// The backend can run many concurrent sessions (one per git worktree); this
// hook keeps a per-session slice of transcript/blueprint/running state and
// tracks which project + session tab is active.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEventEnvelope,
  Blueprint,
  BlueprintEvent,
  RepoScan,
  SessionMeta,
  StreamEvent,
  ToolStatus,
} from "./types";

// Read an artifact by name from a specific session.
export function readArtifact(sessionId: string, name: string): Promise<string | null> {
  return invoke<string | null>("read_artifact", { sessionId, name });
}

// Fetch the built-in + MCP tool status for a session.
export function toolStatus(sessionId: string): Promise<ToolStatus> {
  return invoke<ToolStatus>("tool_status", { sessionId });
}

// Per-session view state. `events` starts empty for restored sessions.
export interface SessionState {
  meta: SessionMeta;
  events: StreamEvent[];
  running: boolean;
  blueprint: Blueprint | null;
  bpOpen: boolean;
}

export interface SessionStore {
  sessions: SessionMeta[]; // tab order
  activeProject: string | null; // a `base` path
  activeId: string | null;
  active: SessionState | null; // the active session's slice
  runningIds: Set<string>;
  get: (id: string) => SessionState | undefined;

  selectProject: (base: string) => void;
  selectSession: (id: string) => void;
  close: (id: string) => Promise<void>;

  send: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  openBlueprint: (open: boolean) => void;
  // Clear one session's transcript display; leaves backend/model history alone.
  clearEvents: (id: string) => void;

  // Inspect a picked directory; throws if it isn't a directory. The caller
  // branches on git-ness / surfaces the error.
  inspectRepo: (path: string) => Promise<RepoScan>;
  // Provision a fresh worktree off origin/<defaultBranch>, or open an existing
  // checkout. Both return the session meta; we add + select it.
  provisionWorktree: (base: string) => Promise<SessionMeta>;
  openWorktree: (path: string) => Promise<SessionMeta>;
}

function freshSlice(meta: SessionMeta): SessionState {
  return { meta, events: [], running: false, blueprint: null, bpOpen: false };
}

export function useSessions(): SessionStore {
  const [store, setStore] = useState<Map<string, SessionState>>(new Map());
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Live refs so the stream listeners / async callbacks (set up once) always
  // read the latest active id and committed store, not a stale closure.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const storeRef = useRef(store);
  storeRef.current = store;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Mutate one session's slice in place, no-op if it's gone.
  const patch = useCallback(
    (id: string, fn: (s: SessionState) => SessionState) => {
      setStore((prev) => {
        const s = prev.get(id);
        if (!s) return prev;
        const next = new Map(prev);
        next.set(id, fn(s));
        return next;
      });
    },
    [],
  );

  // --- streams (subscribed once) ------------------------------------------
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const track = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };

    listen<AgentEventEnvelope>("agent-event", (e) => {
      const { sessionId, event } = e.payload;
      patch(sessionId, (s) => ({
        ...s,
        events: [...s.events, event],
        running:
          event.kind === "done" || event.kind === "error" ? false : s.running,
      }));
    }).then(track);

    listen<BlueprintEvent>("blueprint", (e) => {
      const { sessionId, name, html } = e.payload;
      patch(sessionId, (s) => ({ ...s, blueprint: { name, html }, bpOpen: true }));
    }).then(track);

    // Restore whatever sessions the backend already has.
    invoke<SessionMeta[]>("list_sessions")
      .then((metas) => {
        if (disposed || metas.length === 0) return;
        setStore(new Map(metas.map((m) => [m.id, freshSlice(m)])));
        setSessions(metas);
        setActiveProject(metas[0].base);
        setActiveId(metas[0].id);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [patch]);

  // Insert (or re-select, if already open) a session and make it active.
  const adopt = useCallback((meta: SessionMeta) => {
    setStore((prev) => {
      if (prev.has(meta.id)) return prev; // keep existing transcript
      const next = new Map(prev);
      next.set(meta.id, freshSlice(meta));
      return next;
    });
    setSessions((prev) => (prev.some((s) => s.id === meta.id) ? prev : [...prev, meta]));
    setActiveProject(meta.base);
    setActiveId(meta.id);
  }, []);

  const selectSession = useCallback((id: string) => {
    const s = storeRef.current.get(id);
    if (!s) return;
    setActiveId(id);
    setActiveProject(s.meta.base);
  }, []);

  const selectProject = useCallback((base: string) => {
    setActiveProject(base);
    // Keep the active session if it belongs to this project, else pick its first.
    const cur = activeIdRef.current
      ? storeRef.current.get(activeIdRef.current)
      : undefined;
    if (cur && cur.meta.base === base) return;
    for (const s of storeRef.current.values()) {
      if (s.meta.base === base) {
        setActiveId(s.meta.id);
        break;
      }
    }
  }, []);

  const close = useCallback(
    async (id: string) => {
      await invoke("close_session", { id });
      // Pick a neighboring tab before dropping the closed one.
      if (activeIdRef.current === id) {
        const list = sessionsRef.current;
        const idx = list.findIndex((s) => s.id === id);
        const rest = list.filter((s) => s.id !== id);
        const neighbor = rest[idx] ?? rest[idx - 1] ?? rest[0] ?? null;
        setActiveId(neighbor ? neighbor.id : null);
        setActiveProject(neighbor ? neighbor.base : null);
      }
      setStore((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    },
    [],
  );

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      const id = activeIdRef.current;
      if (!text || !id) return;
      // Guard only THIS session; other sessions may run concurrently.
      const cur = storeRef.current.get(id);
      if (!cur || cur.running) return;
      patch(id, (s) => ({
        ...s,
        events: [...s.events, { kind: "user", data: text }],
        running: true,
      }));
      try {
        await invoke("send_prompt", { sessionId: id, prompt: text });
      } catch (err) {
        patch(id, (s) => ({
          ...s,
          events: [...s.events, { kind: "error", data: String(err) }],
          running: false,
        }));
      }
    },
    [patch],
  );

  const interrupt = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      await invoke("interrupt", { sessionId: id });
    } catch (err) {
      patch(id, (s) => ({
        ...s,
        events: [...s.events, { kind: "error", data: String(err) }],
      }));
    }
    patch(id, (s) => ({ ...s, running: false }));
  }, [patch]);

  const openBlueprint = useCallback(
    (open: boolean) => {
      const id = activeIdRef.current;
      if (!id) return;
      patch(id, (s) => ({ ...s, bpOpen: open }));
    },
    [patch],
  );

  const clearEvents = useCallback(
    (id: string) => {
      patch(id, (s) => ({ ...s, events: [] }));
    },
    [patch],
  );

  const inspectRepo = useCallback(
    (path: string) => invoke<RepoScan>("inspect_repo", { path }),
    [],
  );

  const provisionWorktree = useCallback(
    async (base: string) => {
      const meta = await invoke<SessionMeta>("provision_worktree", { base });
      adopt(meta);
      return meta;
    },
    [adopt],
  );

  const openWorktree = useCallback(
    async (path: string) => {
      const meta = await invoke<SessionMeta>("open_worktree", { path });
      adopt(meta);
      return meta;
    },
    [adopt],
  );

  const active = activeId ? store.get(activeId) ?? null : null;
  const runningIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of store.values()) if (s.running) set.add(s.meta.id);
    return set;
  }, [store]);
  const get = useCallback((id: string) => store.get(id), [store]);

  return {
    sessions,
    activeProject,
    activeId,
    active,
    runningIds,
    get,
    selectProject,
    selectSession,
    close,
    send,
    interrupt,
    openBlueprint,
    clearEvents,
    inspectRepo,
    provisionWorktree,
    openWorktree,
  };
}
