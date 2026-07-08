import { useMemo } from "react";
import { useSession } from "./session";
import { derive } from "./derive";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { StatusRow } from "./components/StatusRow";
import { InputRow } from "./components/InputRow";
import { BlueprintPane } from "./components/BlueprintPane";

// No contract field carries repo/branch, so these are display-only defaults.
const REPO = "~/repos/acme/api";
const BRANCH = "main";

const FOOTER =
  "Enter send · Shift+Enter newline · Esc interrupt · / commands · Ctrl-P menu · ↑↓/wheel scroll · ⧉ blueprint opens beside chat";

export function App() {
  const session = useSession();
  const derived = useMemo(() => derive(session.events), [session.events]);
  const hasBlueprint = session.blueprint != null;

  return (
    <div className="app">
      <Header repo={REPO} branch={BRANCH} phase={derived.phase} />

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
