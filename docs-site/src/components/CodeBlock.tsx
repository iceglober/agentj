import { useState, type ReactNode } from "react";

export function CodeBlock({ children, copy }: { children: ReactNode; copy: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(copy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <pre className="code-block">
      <button className="code-copy" onClick={handleCopy} title="copy">
        {copied ? "copied" : "copy"}
      </button>
      <code>{children}</code>
    </pre>
  );
}
