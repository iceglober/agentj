import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AskQuestion, Block, ToolLine } from "../types";
import { parseDag } from "../dag";
import { SubagentDag } from "./SubagentDag";

const LABEL: Record<string, string> = {
  you: "you",
  agentj: "agentj",
  thinking: "thinking",
  note: "note",
  notice: "notice",
  error: "error",
  tool: "tool",
  task: "task",
  questions: "agentj asks",
};

// Render plain text, highlighting `code` spans between backticks. Used for short system/lifecycle
// lines (note/notice/error) where full markdown would be overkill and errors should stay literal.
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

// Render message text as GitHub-flavored markdown (bold, italics, lists, code, tables, …).
// react-markdown does NOT render raw HTML, so model output can't inject markup.
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function ToolLineRow({ line }: { line: ToolLine }) {
  const [open, setOpen] = useState(false);
  const hasResult = !line.pending && line.result.trim().length > 0;
  // run_subagents shows its task DAG: a popover on hover, and inline when the row is expanded.
  const dag = line.name === "run_subagents" ? parseDag(line.args) : null;
  const expandable = hasResult || !!dag;
  return (
    <div className={"tline" + (line.ok ? "" : " toolfail") + (dag ? " dagrow" : "")}>
      <span
        className={"toolrow" + (expandable ? " expandable" : "")}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        {expandable && <span className="twist">{open ? "▾" : "▸"}</span>}
        <span className="k">{line.name}</span>
        <span className="rail">({line.args})</span>
        {line.pending ? (
          <span className="rail"> — …</span>
        ) : (
          <span className="rail"> — {fmtMs(line.elapsed_ms ?? 0)}</span>
        )}
      </span>
      {dag && !open && (
        <div className="dagpop">
          <SubagentDag dag={dag} />
        </div>
      )}
      {open && dag && (
        <div className="daginline">
          <SubagentDag dag={dag} />
        </div>
      )}
      {open && hasResult && <pre className="toolresult">{line.result}</pre>}
    </div>
  );
}

// One subagent launched by run_subagents: `task[type]: title` with live status; expand to read what
// it returned. Same visual as a tool row.
function TaskRow({ block }: { block: Extract<Block, { type: "task" }> }) {
  const [open, setOpen] = useState(false);
  const running = block.state === "running";
  const hasResult = !running && block.summary.trim().length > 0;
  return (
    <div className={"tline" + (block.state === "fail" ? " toolfail" : "")}>
      <span
        className={"toolrow" + (hasResult ? " expandable" : "")}
        onClick={hasResult ? () => setOpen((v) => !v) : undefined}
      >
        {hasResult && <span className="twist">{open ? "▾" : "▸"}</span>}
        <span className="k">[{block.agentType}]</span>
        <span className="rail">: {block.title}</span>
        {running ? (
          <span className="rail"> — …</span>
        ) : (
          <span className="rail"> — {fmtMs(block.elapsed_ms ?? 0)}</span>
        )}
      </span>
      {open && hasResult && <pre className="toolresult">{block.summary}</pre>}
    </div>
  );
}

// Group consecutive lines that call the SAME tool, so a run collapses to "name × N".
function groupLines(lines: ToolLine[]): { name: string; lines: ToolLine[] }[] {
  const groups: { name: string; lines: ToolLine[] }[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.name === l.name) last.lines.push(l);
    else groups.push({ name: l.name, lines: [l] });
  }
  return groups;
}

// A run of ≥2 consecutive calls to the same tool: collapsed as "name × N", click to expand into the
// individual calls. Aggregate status — a spinner while any is pending, an ✗N count if any failed.
function ToolGroup({ name, lines }: { name: string; lines: ToolLine[] }) {
  const [open, setOpen] = useState(false);
  const pending = lines.some((l) => l.pending);
  const fails = lines.filter((l) => !l.pending && !l.ok).length;
  return (
    <div className={"tline tgroup" + (fails > 0 ? " toolfail" : "")}>
      <span className="toolrow expandable" onClick={() => setOpen((v) => !v)}>
        <span className="twist">{open ? "▾" : "▸"}</span>
        <span className="k">{name}</span>
        <span className="tcount">× {lines.length}</span>
        {pending ? (
          <span className="rail"> — …</span>
        ) : fails > 0 ? (
          <span className="rail"> — ✗{fails}</span>
        ) : null}
      </span>
      {open && (
        <div className="tgroup-body">
          {lines.map((l, i) => (
            <ToolLineRow line={l} key={i} />
          ))}
        </div>
      )}
    </div>
  );
}


// Strip the "(recommended)" marker the tool convention puts on the preferred option — the sent
// answer should read like the user's words, not the menu's.
const cleanLabel = (label: string) => label.replace(/\s*\(recommended\)\s*/i, " ").trim();

// The ask_user block: clickable options per question. A single single-select question sends on
// click; anything richer selects locally and sends once every question has an answer. Free-text
// answers still work through the normal input — this is a shortcut, not a cage.
function QuestionsBlock({
  questions,
  onAnswer,
}: {
  questions: AskQuestion[];
  onAnswer: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, number[]>>({});
  const [sent, setSent] = useState(false);

  const compose = (sel: Record<number, number[]>) =>
    questions
      .map((q, qi) => {
        const labels = (sel[qi] ?? []).map((oi) => cleanLabel(q.options[oi]?.label ?? ""));
        const name = q.header ?? `Q${qi + 1}`;
        return `${name}: ${labels.join(", ")}`;
      })
      .join(" · ");

  const pick = (qi: number, oi: number) => {
    if (sent) return;
    const q = questions[qi];
    // The common case: one single-select question — clicking IS the answer.
    if (questions.length === 1 && !q.multi_select) {
      setSent(true);
      onAnswer(cleanLabel(q.options[oi].label));
      return;
    }
    setPicked((p) => {
      const cur = p[qi] ?? [];
      const next = q.multi_select
        ? cur.includes(oi)
          ? cur.filter((x) => x !== oi)
          : [...cur, oi]
        : [oi];
      return { ...p, [qi]: next };
    });
  };

  const complete = questions.every((_, qi) => (picked[qi] ?? []).length > 0);
  const showSend = questions.length > 1 || questions[0]?.multi_select;

  return (
    <div className={"qs" + (sent ? " sent" : "")}>
      {questions.map((q, qi) => (
        <div className="q" key={qi}>
          <div className="q-head">
            {q.header && <span className="q-chip">{q.header}</span>}
            <span className="q-text">{q.question}</span>
          </div>
          <div className="q-opts">
            {q.options.map((o, oi) => (
              <button
                key={oi}
                className={"q-opt" + ((picked[qi] ?? []).includes(oi) ? " on" : "")}
                disabled={sent}
                title={o.description ?? undefined}
                onClick={() => pick(qi, oi)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {q.options.some((o) => o.description) && (
            <div className="q-descs">
              {q.options.map((o, oi) =>
                o.description ? (
                  <div className="q-desc" key={oi}>
                    <span className="q-desc-label">{cleanLabel(o.label)}</span> — {o.description}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      ))}
      {showSend && !sent && (
        <div className="q-actions">
          <button
            className="btn3d primary"
            disabled={!complete}
            onClick={() => {
              setSent(true);
              onAnswer(compose(picked));
            }}
          >
            Send answers
          </button>
          <span className="q-hint">or type a reply below</span>
        </div>
      )}
      {sent && <div className="q-hint">answered</div>}
    </div>
  );
}

function BlockRow({ block, onAnswer }: { block: Block; onAnswer: (text: string) => void }) {
  const cls =
    block.type === "card" ? `card ${block.role}` : block.type;
  const label = block.type === "card" ? LABEL[block.role] : LABEL[block.type];

  let content: ReactNode;
  switch (block.type) {
    case "card":
    case "thinking":
      content = <Markdown text={block.text} />;
      break;
    case "note":
    case "notice":
    case "error":
      content = <Ticks text={block.text} />;
      break;
    case "tool":
      content = groupLines(block.lines).map((g, i) =>
        g.lines.length === 1 ? (
          <ToolLineRow line={g.lines[0]} key={i} />
        ) : (
          <ToolGroup name={g.name} lines={g.lines} key={i} />
        ),
      );
      break;
    case "task":
      content = <TaskRow block={block} />;
      break;
    case "questions":
      content = <QuestionsBlock questions={block.questions} onAnswer={onAnswer} />;
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
  onOpenLink,
  onAnswer,
}: {
  blocks: Block[];
  autoScroll: boolean;
  onOpenLink: (url: string) => void;
  /** Send an ask_user answer as the next user message (option clicks compose it). */
  onAnswer: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Stick to the bottom as new blocks land — unless the user turned it off,
  // in which case leave their scroll position alone.
  useEffect(() => {
    if (!autoScroll) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, autoScroll]);

  // Intercept ALL link clicks (event delegation) so a link never navigates the whole webview away
  // from agentj — route it to the app instead (an in-app view tab, or the system browser).
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (a && a.getAttribute("href")) {
      e.preventDefault();
      onOpenLink(a.href);
    }
  };

  return (
    <div className="screen" ref={ref} onClick={onClick}>
      {blocks.map((b) => (
        <BlockRow block={b} key={b.id} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
