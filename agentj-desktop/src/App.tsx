import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSession } from "./session";
import { derive } from "./derive";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { StatusRow } from "./components/StatusRow";
import { InputRow } from "./components/InputRow";
import { BlueprintPane } from "./components/BlueprintPane";
import { Welcome } from "./components/Welcome";
import { WorkspaceChooser } from "./components/WorkspaceChooser";
import type { RepoScan } from "./types";

const FOOTER =
  "Enter send · Shift+Enter newline · Esc interrupt · / commands · Ctrl-P menu · ↑↓/wheel scroll · ⧉ blueprint opens beside chat";

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
  const session = useSession();
  const derived = useMemo(() => derive(session.events), [session.events]);
  const hasBlueprint = session.blueprint != null;
  const [recents, setRecents] = useState<string[]>(loadRecents);

  // Open flow state, owned here so both Welcome and Header can drive it.
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

  const provision = useCallback(
    async (base: string) => {
      setChooserError(null);
      setProvisioning(true);
      try {
        // On success the backend emits "repo-changed"; close the chooser.
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

  // No workspace → welcome screen (still allow the chooser to overlay it).
  if (session.repo == null) {
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

  return (
    <div className="app">
      <Header
        repo={session.repo}
        recents={recents}
        onPick={pickRepo}
        onOpenRecent={beginOpen}
        busy={session.running}
        phase={derived.phase}
      />

      <div className="body">
        <div className="chat">
          <Transcript blocks={derived.blocks} />
          <StatusRow
            running={session.running}
            activity={derived.activity}
            totalTokens={derived.totalTokens}
            sawDone={derived.sawDone}
          />
          <InputRow
            onSend={session.send}
            onInterrupt={session.interrupt}
            running={session.running}
          />
          <div className="foot">{FOOTER}</div>

          {hasBlueprint && !session.bpOpen && (
            <div className="bpchip" onClick={() => session.openBlueprint(true)}>
              ⧉ blueprint
            </div>
          )}
        </div>

        <BlueprintPane
          blueprint={session.blueprint}
          open={session.bpOpen}
          onClose={() => session.openBlueprint(false)}
        />
      </div>

      {chooser}
    </div>
  );
}
