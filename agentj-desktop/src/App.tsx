import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions } from "./session";
import { derive } from "./derive";
import { TabBar } from "./components/TabBar";
import { Transcript } from "./components/Transcript";
import { StatusRow } from "./components/StatusRow";
import { InputRow } from "./components/InputRow";
import { BlueprintPane } from "./components/BlueprintPane";
import { Welcome } from "./components/Welcome";
import { WorkspaceChooser } from "./components/WorkspaceChooser";
import type { RepoScan } from "./types";

const FOOTER =
  "Enter send · Shift+Enter newline · Esc interrupt · / commands · ↑↓/wheel scroll · ⧉ blueprint opens beside chat";

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

export function App() {
  const session = useSessions();
  const active = session.active;
  const derived = useMemo(
    () => derive(active?.events ?? []),
    [active?.events],
  );

  const [recents, setRecents] = useState<string[]>(loadRecents);

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
      </div>
    );
  }

  const hasBlueprint = active?.blueprint != null;

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
      />

      <div className="body">
        <div className="chat">
          <Transcript blocks={derived.blocks} />
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
          />
          <div className="foot">{FOOTER}</div>

          {hasBlueprint && !active?.bpOpen && (
            <div className="bpchip" onClick={() => session.openBlueprint(true)}>
              ⧉ blueprint
            </div>
          )}
        </div>

        <BlueprintPane
          blueprint={active?.blueprint ?? null}
          open={active?.bpOpen ?? false}
          onClose={() => session.openBlueprint(false)}
        />
      </div>

      {chooser}
    </div>
  );
}
