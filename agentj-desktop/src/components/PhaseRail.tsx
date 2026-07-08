import { PHASES, type Phase } from "../derive";

export function PhaseRail({ phase }: { phase: Phase | null }) {
  const current = phase ? PHASES.indexOf(phase) : -1;
  return (
    <div className="phases" aria-label="phase">
      {PHASES.map((p, i) => (
        <span key={p} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            className={
              "ph" +
              (p === phase ? " on" : "") +
              (current >= 0 && i <= current ? " reached" : "")
            }
            data-p={p}
          >
            <span className="dot" />
            {p}
          </span>
          {i < PHASES.length - 1 && <span className="arw">→</span>}
        </span>
      ))}
    </div>
  );
}
