import { PhaseRail } from "./PhaseRail";
import type { Phase } from "../derive";

export function Header({
  repo,
  branch,
  phase,
}: {
  repo: string;
  branch: string;
  phase: Phase | null;
}) {
  return (
    <div className="topbar">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      <span className="ttl">
        <b>agentj</b> — {repo} · {branch}
      </span>
      <PhaseRail phase={phase} />
    </div>
  );
}
