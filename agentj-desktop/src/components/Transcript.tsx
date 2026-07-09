import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Block, ToolLine, Wave } from "../types";

const LABEL: Record<string, string> = {
  you: "you",
  agentj: "agentj",
  thinking: "thinking",
  note: "note",
  notice: "notice",
  error: "error",
  tool: "tool",
  tray: "",
};

// Render plain text, highlighting `code` spans between backticks.
function Ticks({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          <span className="k" key={i}>
            {p.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function ToolLineRow({ line }: { line: ToolLine }) {
  const [open, setOpen] = useState(false);
  const hasResult = !line.pending && line.result.trim().length > 0;
  return (
    <div className={"tline" + (line.ok ? "" : " toolfail")}>
      <span
        className={"toolrow" + (hasResult ? " expandable" : "")}
        onClick={hasResult ? () => setOpen((v) => !v) : undefined}
      >
        {hasResult && <span className="twist">{open ? "▾" : "▸"}</span>}
        <span className="k">{line.name}</span>
        <span className="rail">({line.args})</span>
        {line.pending ? (
          <span className="rail"> — …</span>
        ) : (
          <span className="rail"> — {fmtMs(line.elapsed_ms ?? 0)}</span>
        )}
      </span>
      {open && <pre className="toolresult">{line.result}</pre>}
    </div>
  );
}

// The subagent wave: a group box with one row per subagent — type chip · title · duration bar ·
// live status · tokens/elapsed — and a join footer. The bar shows each agent's share of the wave's
// wall-clock (the slowest fills it), so the parallel spread is visible at a glance.
//   ├─╯  wave 1 · 2/2 ok · 11.4s · 7.2k tok
const KNOWN_TYPES = ["scout", "planner", "reviewer", "executor"];
const fmtTokShort = (t: number | null): string =>
  t && t > 0 ? `${(t / 1000).toFixed(1)}k` : "";

function Tray({ wave }: { wave: Wave }) {
  const subs = wave.subagents;
  const n = subs.length;
  const okCount = subs.filter((s) => s.ok === true).length;
  const doneCount = subs.filter((s) => s.done).length;
  const maxElapsed = subs.reduce((m, s) => Math.max(m, s.elapsed_ms ?? 0), 1);
  const totalTok = subs.reduce((m, s) => m + (s.tokens ?? 0), 0);
  const allDone = doneCount === n;

  return (
    <div className="wave">
      <div className="wave-head">
        <span>
          <b>run_subagents</b> · wave {wave.n} · {n} in parallel
        </span>
        <span>{allDone ? "" : <><span className="spin">◍</span> running</>}</span>
      </div>

      {subs.map((s) => {
        const type = KNOWN_TYPES.includes(s.type) ? s.type : "other";
        const running = s.ok == null;
        const st = running ? s.status || "working…" : s.summary || (s.ok ? "done" : "failed");
        return (
          <div className="wrow" key={s.id}>
            <span className={"wchip " + type}>{s.type || "sub"}</span>
            <span className="wtitle" title={s.desc}>
              {s.desc}
            </span>
            <span className={"wst" + (running ? "" : s.ok ? " ok" : " err")}>
              {running ? <span className="spin">◍</span> : s.ok ? "✓" : "✗"}{" "}
              <span className="wst-txt" title={st}>
                {st}
              </span>
            </span>
            <span className="wmeta">
              {fmtTokShort(s.tokens)}
              {s.elapsed_ms != null ? ` · ${fmtMs(s.elapsed_ms)}` : ""}
            </span>
          </div>
        );
      })}

      <div className="wave-foot">
        <span>
          {allDone ? <b>{okCount}/{n} ok</b> : `${doneCount}/${n} done`}
        </span>
        <span>
          {totalTok > 0 ? `${(totalTok / 1000).toFixed(1)}k tok` : ""}
          {allDone ? ` · ${fmtMs(maxElapsed)} wall` : ""}
        </span>
      </div>
    </div>
  );
}

function BlockRow({ block }: { block: Block }) {
  const cls =
    block.type === "card" ? `card ${block.role}` : block.type;
  const label = block.type === "card" ? LABEL[block.role] : LABEL[block.type];

  let content: ReactNode;
  switch (block.type) {
    case "card":
    case "thinking":
    case "note":
    case "notice":
    case "error":
      content = <Ticks text={block.text} />;
      break;
    case "tool":
      content = block.lines.map((l, i) => <ToolLineRow line={l} key={i} />);
      break;
    case "tray":
      content = <Tray wave={block.wave} />;
      break;
  }

  return (
    <div className={`blk ${cls}`}>
      <div className="lbl">{label}</div>
      <div className="cnt">{content}</div>
    </div>
  );
}

export function Transcript({
  blocks,
  autoScroll,
}: {
  blocks: Block[];
  autoScroll: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Stick to the bottom as new blocks land — unless the user turned it off,
  // in which case leave their scroll position alone.
  useEffect(() => {
    if (!autoScroll) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, autoScroll]);

  return (
    <div className="screen" ref={ref}>
      {blocks.map((b) => (
        <BlockRow block={b} key={b.id} />
      ))}
    </div>
  );
}
