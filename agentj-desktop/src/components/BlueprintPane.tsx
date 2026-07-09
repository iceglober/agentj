import type { Blueprint } from "../types";

// The full-width blueprint view (tier-3 "Blueprint" tab). Fills the body so an
// interactive UX mockup has the whole window to render in. `onClose` returns to
// the chat view (same as clicking the Chat tab).
export function BlueprintPane({
  blueprint,
  onClose,
}: {
  blueprint: Blueprint | null;
  onClose: () => void;
}) {
  if (!blueprint) return null;
  return (
    <div className="blueprint">
      <div className="bpbar">
        <span className="name">{blueprint.name}</span>
        <span className="addr">session://artifacts/{blueprint.name}.html</span>
        <button className="x" onClick={onClose} title="Back to chat" aria-label="Back to chat">
          ✕
        </button>
      </div>
      <iframe title={blueprint.name} srcDoc={blueprint.html} sandbox="allow-scripts" />
    </div>
  );
}
