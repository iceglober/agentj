import { useEffect, useState, type ReactNode } from "react";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function StatusRow({
  running,
  activity,
  totalTokens,
  sawDone,
}: {
  running: boolean;
  activity: string;
  totalTokens: number;
  sawDone: boolean;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 90);
    return () => clearInterval(t);
  }, [running]);

  let dot: ReactNode;
  let label: string;
  if (running) {
    dot = <span className="spin">{SPIN[frame]}</span>;
    label = activity;
  } else if (sawDone) {
    dot = <span className="ok">✓</span>;
    label = "all set";
  } else {
    dot = <span>●</span>;
    label = "idle";
  }

  return (
    <div className="status">
      {dot} <span className="live">{label}</span>
      <span className="tok">⇢ {(totalTokens / 1000).toFixed(1)}k tok</span>
    </div>
  );
}
