import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSession } from "./session";
import { derive } from "./derive";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { StatusRow } from "./components/StatusRow";
import { InputRow } from "./components/InputRow";
import { BlueprintPane } from "./components/BlueprintPane";

const FOOTER =
  "Enter send · Shift+Enter newline · Esc interrupt · / commands · Ctrl-P menu · ↑↓/wheel scroll · ⧉ blueprint opens beside chat";

const RECENTS_KEY = "agentj.recents";
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

  const remember = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 6);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const chooseRepo = useCallback(
    async (path: string) => {
      remember(path);
      await session.openRepo(path);
    },
    [remember, session],
  );

  const pickRepo = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: "Open a repository" });
    if (typeof dir === "string") await chooseRepo(dir);
  }, [chooseRepo]);

  return (
    <div className="app">
      <Header
        repo={session.repo}
        recents={recents}
        onPick={pickRepo}
        onOpenRecent={chooseRepo}
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
    </div>
  );
}
