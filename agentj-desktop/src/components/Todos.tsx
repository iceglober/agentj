import type { TodoItem } from "../todos";

// Read-only checklist of the session's todos. The agent owns the list; this
// only reflects it. Done items are struck-through/dim, doing items bold, plus
// an "N of M done" line with a thin progress bar.
export function Todos({ items }: { items: TodoItem[] }) {
  const total = items.length;
  const done = items.filter((i) => i.state === "done").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="secbody">
      <div className="todos">
        {items.map((it, i) => (
          <div key={i} className={"todo " + it.state}>
            <span className="cb" />
            <span className="txt">{it.text}</span>
          </div>
        ))}
      </div>
      <div className="prog">
        {done} of {total} done
        <div className="progbar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
