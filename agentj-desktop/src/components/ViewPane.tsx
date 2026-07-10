import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenView } from "../types";

// A URL opened from a transcript link, rendered in a sandboxed iframe so it never replaces the
// agentj window. Toolbar: reload, open-in-browser (for pages that refuse framing), close.
export function ViewPane({ view, onClose }: { view: OpenView; onClose: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="viewpane">
      <div className="vbar">
        <span className="vaddr" title={view.url}>
          {view.url}
        </span>
        <button className="vbtn" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>
          ⟳
        </button>
        <button
          className="vbtn"
          title="Open in system browser"
          onClick={() => void invoke("open_url", { url: view.url })}
        >
          ⧉
        </button>
        <button className="vbtn" title="Close view" onClick={onClose}>
          ✕
        </button>
      </div>
      <iframe key={reloadKey} title={view.title} src={view.url} />
    </div>
  );
}
