import type { Dag } from "../dag";

// Small SVG of the run_subagents DAG: nodes laid out by stage (top→bottom), tasks within a stage
// side-by-side, edges from each task down to the tasks it runs `after`. Node color = agent type.
const TYPE_COLOR: Record<string, string> = {
  scout: "#2f6fe0",
  planner: "#9a6600",
  reviewer: "#8a4bd6",
  executor: "#0a5e2a",
};

const W = 132;
const H = 28;
const GX = 14;
const GY = 26;

export function SubagentDag({ dag }: { dag: Dag }) {
  const { tasks, stages } = dag;
  const numStages = Math.max(...stages) + 1;

  // Column of each task within its stage, and how many share each stage.
  const col = new Array<number>(tasks.length);
  const perStage = new Array<number>(numStages).fill(0);
  tasks.forEach((_, i) => {
    col[i] = perStage[stages[i]]++;
  });
  const maxCols = Math.max(...perStage, 1);
  const pos = (i: number) => ({ x: col[i] * (W + GX), y: stages[i] * (H + GY) });

  const svgW = maxCols * (W + GX) - GX;
  const svgH = numStages * (H + GY) - GY;

  return (
    <div className="dag">
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
        {tasks.flatMap((t, i) =>
          t.after.map((dep, k) => {
            const a = pos(i);
            const b = pos(dep);
            const x1 = a.x + W / 2;
            const y1 = a.y; // top of the dependent
            const x2 = b.x + W / 2;
            const y2 = b.y + H; // bottom of the dependency
            const my = (y1 + y2) / 2;
            return (
              <path
                key={`${i}-${k}`}
                className="dagedge"
                d={`M${x2},${y2} C${x2},${my} ${x1},${my} ${x1},${y1}`}
              />
            );
          }),
        )}
        {tasks.map((t, i) => {
          const p = pos(i);
          const color = TYPE_COLOR[t.type] || "#666";
          return (
            <g key={i} transform={`translate(${p.x},${p.y})`}>
              <rect className="dagnode" width={W} height={H} rx={2} style={{ stroke: color }} />
              <text className="dagtype" x={7} y={11} style={{ fill: color }}>
                {t.type}
              </text>
              <text className="dagtitle" x={7} y={22}>
                {t.title.length > 22 ? t.title.slice(0, 21) + "…" : t.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
