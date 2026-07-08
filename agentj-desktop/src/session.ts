// Bridge to the Tauri backend: subscribe to the event streams and expose
// the three commands. All backend contact lives here.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, Blueprint, StreamEvent } from "./types";

export function readArtifact(name: string): Promise<string | null> {
  return invoke<string | null>("read_artifact", { name });
}

export interface Session {
  events: StreamEvent[];
  running: boolean;
  blueprint: Blueprint | null;
  bpOpen: boolean;
  send: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  openBlueprint: (open: boolean) => void;
}

export function useSession(): Session {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [bpOpen, setBpOpen] = useState(false);
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

  return { events, running, blueprint, bpOpen, send, interrupt, openBlueprint };
}
