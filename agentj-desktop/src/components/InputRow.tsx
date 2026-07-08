import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isCommandName, matchCommands, type Command } from "../commands";

export function InputRow({
  onSend,
  onInterrupt,
  running,
  commands,
  onRunCommand,
}: {
  onSend: (prompt: string) => void;
  onInterrupt: () => void;
  running: boolean;
  commands: Command[];
  onRunCommand: (name: string) => void;
}) {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // The palette shows while the text is a single "/…" token (no space yet).
  const paletteOpen = value.startsWith("/") && !/\s/.test(value);
  const matches = useMemo(
    () => (paletteOpen ? matchCommands(value, commands) : []),
    [paletteOpen, value, commands],
  );
  const showPalette = paletteOpen && matches.length > 0;
  const clampedSel = showPalette ? Math.min(sel, matches.length - 1) : 0;

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };

  const reset = () => {
    setValue("");
    setSel(0);
    if (ref.current) ref.current.style.height = "auto";
  };

  const run = (name: string) => {
    onRunCommand(name);
    reset();
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    // Exact command name → run it instead of sending as a prompt.
    if (isCommandName(text, commands)) {
      run(text);
      return;
    }
    onSend(text);
    reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPalette) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSel((s) => (s + 1) % matches.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setSel((s) => (s - 1 + matches.length) % matches.length);
          return;
        case "Enter":
        case "Tab":
          e.preventDefault();
          run(matches[clampedSel].name);
          return;
        case "Escape":
          // Close the palette; do NOT interrupt while it's open.
          e.preventDefault();
          reset();
          return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div className="input-wrap">
      {showPalette && (
        <div className="cmd-palette" role="listbox">
          {matches.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={i === clampedSel}
              className={"cmd-item" + (i === clampedSel ? " active" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                run(c.name);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="cmd-name">{c.name}</span>
              <span className="cmd-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="input">
        <span className="caret">›</span>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder="ask agentj to do something…"
          onChange={(e) => {
            setValue(e.target.value);
            setSel(0);
            autosize(e.target);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoFocus
        />
      </div>
    </div>
  );
}
