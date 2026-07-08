import { useEffect } from "react";
import { SHORTCUTS } from "../keymap";

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Keyboard shortcuts</h2>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <table className="keys">
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.id}>
                  <td className="keys-combo">
                    {s.keys.map((k, i) => (
                      <kbd className="chip" key={i}>
                        {k}
                      </kbd>
                    ))}
                  </td>
                  <td className="keys-action">{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
