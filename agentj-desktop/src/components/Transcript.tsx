import { useEffect, useRef, type ReactNode } from "react";
import type { Block, ToolLine, Wave } from "../types";

const LABEL: Record<string, string> = {
  you: "you",
  agentj: "agentj",
  thinking: "thinking",
  note: "note",
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
  const prefixClass = line.prefix === "✗" ? "err" : "rail";
  return (
    <span className="tline">
      <span className={prefixClass}>{line.prefix}</span>{" "}
      <span className="k">{line.name}</span>
      <span className="rail">({line.args})</span>
      {line.pending ? (
        <span className="rail"> — …</span>
      ) : (
        <>
          <span className="rail"> — {fmtMs(line.elapsed_ms ?? 0)}</span>
          {line.summary ? " " : ""}
          {line.summary}
        </>
      )}
    </span>
  );
}

function fmtTok(tokens: number | null): string {
  return tokens != null ? ` · ${(tokens / 1000).toFixed(1)}k tok` : "";
}

// The fork/join subagent tray, mirroring the ratatui view:
//   ├─┬─ ✓ desc · status — 8.1s · 3.2k tok
//   │ ╰─ ✓ desc · status — 11.4s · 4.0k tok
//   ├─╯  wave 1 · 2/2 ok · 11.4s · 7.2k tok
function Tray({ wave }: { wave: Wave }) {
  const subs = wave.subagents;
  const n = subs.length;
  const okCount = subs.filter((s) => s.ok === true).length;
  const maxElapsed = subs.reduce((m, s) => Math.max(m, s.elapsed_ms ?? 0), 0);
  const totalTok = subs.reduce((m, s) => m + (s.tokens ?? 0), 0);

  const connector = (i: number): string => {
    if (n === 1) return "├──";
    if (i === 0) return "├─┬─";
    if (i === n - 1) return "│ ╰─";
    return "│ ├─";
  };
  const mark = (s: (typeof subs)[number]) =>
    s.ok == null ? (
      <span className="spin">◍</span>
    ) : s.ok ? (
      <span className="ok">✓</span>
    ) : (
      <span className="err">✗</span>
    );

  return (
    <>
      {subs.map((s, i) => (
        <span className="tline" key={s.id}>
          <span className="rail">{connector(i)}</span> {mark(s)} {s.desc}
          {s.status ? <span className="rail"> · {s.status}</span> : null}
          {s.elapsed_ms != null ? (
            <span className="rail">
              {" "}
              — {fmtMs(s.elapsed_ms)}
              {fmtTok(s.tokens)}
            </span>
          ) : (
            <span className="rail">{fmtTok(s.tokens)}</span>
          )}
        </span>
      ))}
      <span className="tline">
        <span className="rail">
          ├─╯&nbsp;&nbsp;wave {wave.n} · {okCount}/{n} ok · {fmtMs(maxElapsed)}
          {totalTok > 0 ? ` · ${(totalTok / 1000).toFixed(1)}k tok` : ""}
        </span>
      </span>
    </>
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

export function Transcript({ blocks }: { blocks: Block[] }) {
  const ref = useRef<HTMLDivElement>(null);

  // Stick to the bottom as new blocks land.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  return (
    <div className="screen" ref={ref}>
      {blocks.map((b) => (
        <BlockRow block={b} key={b.id} />
      ))}
    </div>
  );
}
