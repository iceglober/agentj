import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSessions } from "./session";
import { useSettings } from "./settings";
import { derive } from "./derive";
import { TabBar } from "./components/TabBar";
import { Transcript } from "./components/Transcript";
import { StatusRow } from "./components/StatusRow";
import { InputRow } from "./components/InputRow";
import { LeftRail } from "./components/LeftRail";
import { StatusBar } from "./components/StatusBar";
import { Welcome } from "./components/Welcome";
import { WorkspaceChooser } from "./components/WorkspaceChooser";
import { Settings, type SettingsTab } from "./components/Settings";
import { Shortcuts } from "./components/Shortcuts";
import { ToolStatus } from "./components/ToolStatus";
import { ModelPicker } from "./components/ModelPicker";
import { ViewPane } from "./components/ViewPane";
import { COMMANDS } from "./commands";
import type { RepoScan } from "./types";

// Recents store BASE repo paths (the main repo dir), not individual worktrees.
const RECENTS_KEY = "agentj.workspaces";
function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

// A locally-running server (dev app) — safe to frame in an in-app view. Anything else opens in the
// system browser (external sites often refuse framing, and belong in a real browser anyway).
function isLocalHttp(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function App() {
  const session = useSessions();
  const active = session.active;
  const derived = useMemo(
    () => derive(active?.events ?? []),
    [active?.events],
  );

  const [recents, setRecents] = useState<string[]>(loadRecents);

  // Display preferences that shape the transcript.
  const { settings, set: setSetting } = useSettings();

  // Apply the display toggles before the transcript sees them.
  const visibleBlocks = useMemo(() => {
    return derived.blocks.filter((b) => {
      if (!settings.showThinking && b.type === "thinking") return false;
      if (!settings.showTools && (b.type === "tool" || b.type === "task")) return false;
      return true;
    });
  }, [derived.blocks, settings.showThinking, settings.showTools]);

  // Only one modal open at a time.
  const [modal, setModal] = useState<"settings" | "shortcuts" | "tools" | "models" | null>(null);
  // Which Settings section to land on ("/config" and the gear item open straight to Project).
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");

  // Open flow state, owned here so Welcome, the tier-1 "+", and recents drive it.
  const [scan, setScan] = useState<RepoScan | null>(null); // chooser open ⇔ non-null
  const [openError, setOpenError] = useState<string | null>(null);
  const [chooserError, setChooserError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const remember = useCallback((base: string) => {
    setRecents((prev) => {
      const next = [base, ...prev.filter((p) => p !== base)].slice(0, 6);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Inspect a picked/recent path; git → open the chooser, otherwise surface the error.
  const beginOpen = useCallback(
    async (path: string) => {
      setOpenError(null);
      let s: RepoScan;
      try {
        s = await session.inspectRepo(path);
      } catch (err) {
        setOpenError(String(err));
        return;
      }
      if (!s.isGit) {
        setOpenError(`not a git repository: ${path}`);
        return;
      }
      remember(s.base);
      setChooserError(null);
      setScan(s);
    },
    [session, remember],
  );

  const pickRepo = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: "Open a repository" });
    if (typeof dir === "string") await beginOpen(dir);
  }, [beginOpen]);

  // Chooser "Continue" → provision a managed worktree off the base.
  const provision = useCallback(
    async (base: string) => {
      setChooserError(null);
      setProvisioning(true);
      try {
        await session.provisionWorktree(base);
        setScan(null);
      } catch (err) {
        setChooserError(String(err));
      } finally {
        setProvisioning(false);
      }
    },
    [session],
  );

  // Chooser disclosure → resume an existing worktree.
  const resume = useCallback(
    async (path: string) => {
      setChooserError(null);
      try {
        await session.openWorktree(path);
        setScan(null);
      } catch (err) {
        setChooserError(String(err));
      }
    },
    [session],
  );

  // Tier-2 "+" → provision a fresh worktree under the active project, no chooser.
  const newSession = useCallback(async () => {
    if (!session.activeProject) return;
    setProvisioning(true);
    try {
      await session.provisionWorktree(session.activeProject);
    } catch (err) {
      setOpenError(String(err));
    } finally {
      setProvisioning(false);
    }
  }, [session]);

  // Slash-command dispatch. InputRow (and future callers) run commands by name;
  // App owns the effects (modals, store actions, the open flow).
  const runCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "/init":
          void session.send(
            "Map this repository and write its AGENTS.md — survey the structure, entry points, conventions, and how to build & test, then write or update AGENTS.md at the repo root.",
          );
          break;
        case "/mcp":
          setModal("tools");
          break;
        case "/new":
          if (session.activeProject) void newSession();
          else void pickRepo();
          break;
        case "/close":
          if (session.activeId) void session.close(session.activeId);
          break;
        case "/settings":
          setSettingsTab("general");
          setModal("settings");
          break;
        case "/config":
          setSettingsTab("hooks");
          setModal("settings");
          break;
        case "/shortcuts":
          setModal("shortcuts");
          break;
        case "/clear":
          if (session.activeId) session.clearEvents(session.activeId);
          break;
      }
    },
    [session, newSession, pickRepo],
  );

  // Global ⌘-combo shortcuts. Esc-to-close lives in the modal components; here
  // we only handle the ⌘ combos so they don't type into the textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const modalOpen = modal !== null;
      switch (e.key) {
        case ",": // ⌘, — Settings
          e.preventDefault();
          setSettingsTab("general");
          setModal("settings");
          break;
        case "/": // ⌘/ — Keyboard shortcuts
          e.preventDefault();
          setModal("shortcuts");
          break;
        case "t":
        case "T": // ⌘T — new worktree session in the active project
          if (modalOpen) return;
          e.preventDefault();
          if (session.activeProject) {
            void session.provisionWorktree(session.activeProject);
          } else {
            void pickRepo();
          }
          break;
        case "w":
        case "W": // ⌘W — close the active session
          if (modalOpen) return;
          if (!session.activeId) return;
          e.preventDefault();
          void session.close(session.activeId);
          break;
        case "o":
        case "O": // ⌘⇧O — open a repository
          if (!e.shiftKey) return;
          e.preventDefault();
          void pickRepo();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, session, pickRepo]);

  const chooser = scan && (
    <WorkspaceChooser
      scan={scan}
      provisioning={provisioning}
      error={chooserError}
      onProvision={provision}
      onOpen={resume}
      onClose={() => setScan(null)}
    />
  );

  // A transcript link never navigates the app: a local dev URL opens as an in-app view tab; anything
  // else opens in the system browser. (Declared before any early return — Rules of Hooks.)
  const onOpenLink = useCallback(
    (url: string) => {
      if (isLocalHttp(url)) session.openView(url);
      else void invoke("open_url", { url });
    },
    [session],
  );

  // No sessions → welcome screen (still allow the chooser to overlay it).
  if (session.sessions.length === 0) {
    return (
      <div className="app">
        <Welcome
          recents={recents}
          onOpen={pickRepo}
          onOpenRecent={beginOpen}
          error={openError}
        />
        {chooser}
        {modal === "settings" && (
          <Settings
            settings={settings}
            onSet={setSetting}
            onClose={() => setModal(null)}
            meta={null}
            totalTokens={0}
            initialTab={settingsTab}
          />
        )}
        {modal === "shortcuts" && <Shortcuts onClose={() => setModal(null)} />}
      </div>
    );
  }

  const activeView = active?.activeView ?? "chat";
  const viewObj = active?.views.find((v) => v.id === activeView) ?? null;

  return (
    <div className="app">
      <TabBar
        sessions={session.sessions}
        activeProject={session.activeProject}
        activeId={session.activeId}
        runningIds={session.runningIds}
        provisioning={provisioning}
        onSelectProject={session.selectProject}
        onSelectSession={session.selectSession}
        onCloseSession={session.close}
        onNewProject={pickRepo}
        onNewSession={newSession}
        onOpenSettings={() => {
          setSettingsTab("general");
          setModal("settings");
        }}
        onOpenShortcuts={() => setModal("shortcuts")}
        onOpenTools={() => setModal("tools")}
        onOpenModels={() => setModal("models")}
        onOpenConfig={() => {
          setSettingsTab("hooks");
          setModal("settings");
        }}
        views={active?.views ?? []}
        activeView={activeView}
        onSelectView={session.setActiveView}
        onCloseView={session.closeView}
      />

      <div className="body">
        {viewObj ? (
          <ViewPane view={viewObj} onClose={() => session.closeView(viewObj.id)} />
        ) : (
          <>
            {session.activeId && (
              <LeftRail sessionId={session.activeId} todos={active?.todos ?? null} />
            )}

            <div className="chat">
              <Transcript
                blocks={visibleBlocks}
                autoScroll={settings.autoScroll}
                onOpenLink={onOpenLink}
                onAnswer={(t) => void session.send(t)}
              />
              <StatusRow
                running={active?.running ?? false}
                activity={derived.activity}
                totalTokens={derived.totalTokens}
                sawDone={derived.sawDone}
              />
              <InputRow
                onSend={session.send}
                onInterrupt={session.interrupt}
                running={active?.running ?? false}
                commands={COMMANDS}
                onRunCommand={runCommand}
              />
            </div>
          </>
        )}
      </div>

      <StatusBar meta={active?.meta ?? null} onOpenModels={() => setModal("models")} />

      {chooser}

      {modal === "settings" && (
        <Settings
          settings={settings}
          onSet={setSetting}
          onClose={() => setModal(null)}
          meta={active?.meta ?? null}
          totalTokens={derived.totalTokens}
          initialTab={settingsTab}
        />
      )}
      {modal === "shortcuts" && <Shortcuts onClose={() => setModal(null)} />}
      {modal === "tools" && (
        <ToolStatus sessionId={session.activeId} onClose={() => setModal(null)} />
      )}
      {modal === "models" && (
        <ModelPicker
          sessionId={session.activeId}
          sessionModel={active?.meta.model ?? null}
          onClose={() => setModal(null)}
          onSessionModel={session.setSessionModel}
        />
      )}
    </div>
  );
}
