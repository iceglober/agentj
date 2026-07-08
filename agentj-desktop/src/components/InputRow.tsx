import { useRef, useState, type KeyboardEvent } from "react";

export function InputRow({
  onSend,
  onInterrupt,
  running,
}: {
  onSend: (prompt: string) => void;
  onInterrupt: () => void;
  running: boolean;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div className="input">
      <span className="caret">›</span>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder="ask agentj to do something…"
        onChange={(e) => {
          setValue(e.target.value);
          autosize(e.target);
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoFocus
      />
    </div>
  );
}
