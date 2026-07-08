// Bridge to the Tauri backend: subscribe to the event streams and expose
// the three commands. All backend contact lives here.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, Blueprint, RepoInfo, RepoScan, StreamEvent } from "./types";

export function readArtifact(name: string): Promise<string | null> {
  return invoke<string | null>("read_artifact", { name });
}

export interface Session {
  events: StreamEvent[];
  running: boolean;
  blueprint: Blueprint | null;
  bpOpen: boolean;
  repo: RepoInfo | null;
  send: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  openBlueprint: (open: boolean) => void;
  // Inspect a picked directory. Throws if the path isn't a directory; the
  // caller decides what to do with the scan (git → chooser, else → error).
  inspectRepo: (path: string) => Promise<RepoScan>;
  // Provision a fresh worktree off origin/<base> or resume an existing checkout.
  // Both let the backend's "repo-changed" event drive the transcript reset,
  // and surface failures as an injected error event.
  provisionWorktree: (base: string) => Promise<void>;
  openWorktree: (path: string) => Promise<void>;
}

export function useSession(): Session {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [bpOpen, setBpOpen] = useState(false);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const push = useCallback((ev: StreamEvent) => setEvents((p) => [...p, ev]), []);

  // Keep a live ref so the send/interrupt callbacks stay stable.
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const track = (u: UnlistenFn) => {
      if (disposed) u();
      else unlisteners.push(u);
    };

    listen<AgentEvent>("agent-event", (e) => {
      const ev = e.payload;
      push(ev);
      if (ev.kind === "done" || ev.kind === "error") setRunning(false);
    }).then(track);

    listen<Blueprint>("blueprint", (e) => {
      setBlueprint(e.payload);
      setBpOpen(true);
    }).then(track);

    // A repo switch resets everything: new working dir, fresh conversation.
    listen<RepoInfo>("repo-changed", (e) => {
      setRepo(e.payload);
      setEvents([]);
      setBlueprint(null);
      setBpOpen(false);
      setRunning(false);
    }).then(track);

    // Seed the header with the repo the app launched in.
    invoke<RepoInfo>("current_repo").then(setRepo).catch(() => {});

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [push]);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      push({ kind: "user", data: text });
      setRunning(true);
      try {
        await invoke("send_prompt", { prompt: text });
      } catch (err) {
        push({ kind: "error", data: String(err) });
        setRunning(false);
      }
    },
    [push],
  );

  const interrupt = useCallback(async () => {
    try {
      await invoke("interrupt");
    } catch (err) {
      push({ kind: "error", data: String(err) });
    }
    setRunning(false);
  }, [push]);

  const openBlueprint = useCallback((open: boolean) => setBpOpen(open), []);

  // Inspect only reads; let it throw so the caller can branch on git-ness/error.
  const inspectRepo = useCallback(
    (path: string) => invoke<RepoScan>("inspect_repo", { path }),
    [],
  );

  const provisionWorktree = useCallback(
    async (base: string) => {
      if (runningRef.current) {
        const msg = "interrupt the running turn before switching workspaces";
        push({ kind: "error", data: msg });
        throw new Error(msg);
      }
      try {
        // The backend emits "repo-changed", which resets events/blueprint/running above.
        await invoke<RepoInfo>("provision_worktree", { base });
      } catch (err) {
        push({ kind: "error", data: String(err) });
        throw err;
      }
    },
    [push],
  );

  const openWorktree = useCallback(
    async (path: string) => {
      if (runningRef.current) {
        const msg = "interrupt the running turn before switching workspaces";
        push({ kind: "error", data: msg });
        throw new Error(msg);
      }
      try {
        await invoke<RepoInfo>("open_worktree", { path });
      } catch (err) {
        push({ kind: "error", data: String(err) });
        throw err;
      }
    },
    [push],
  );

  return {
    events,
    running,
    blueprint,
    bpOpen,
    repo,
    send,
    interrupt,
    openBlueprint,
    inspectRepo,
    provisionWorktree,
    openWorktree,
  };
}
