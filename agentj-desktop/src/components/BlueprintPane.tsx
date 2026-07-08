import type { Blueprint } from "../types";

export function BlueprintPane({
  blueprint,
  open,
  onClose,
}: {
  blueprint: Blueprint | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <div className={"blueprint" + (open && blueprint ? " open" : "")}>
      {blueprint && (
        <>
          <div className="bpbar">
            <span className="name">{blueprint.name}</span>
            <span className="addr">session://artifacts/{blueprint.name}.html</span>
            <button className="x" onClick={onClose} title="Collapse" aria-label="Collapse">
              ✕
            </button>
          </div>
          <iframe
            title={blueprint.name}
            srcDoc={blueprint.html}
            sandbox="allow-scripts"
          />
        </>
      )}
    </div>
  );
}
