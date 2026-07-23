import { useState, useEffect } from "react";
import { Link } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MdLink({ href, children }: { href?: string; children?: any }) {
  if (href && href.startsWith("/")) {
    return <Link to={href}>{children}</Link>;
  }
  return <a href={href}>{children}</a>;
}

function cleanChangelog(raw: string): string {
  return raw
    // Strip the h1 title line (e.g. "# @glrs-dev/glorious")
    .replace(/^#\s+@glrs-dev\/.*\n+/, "")
    // Remove empty version sections (just "## X.Y.Z" with no content before next heading)
    .replace(/^(## \d+\.\d+\.\d+)\n+(## )/gm, "$2");
}

export function Changelog() {
  const [changelog, setChangelog] = useState<string | null>(null);

  useEffect(() => {
    document.title = "changelog — glrs";
  }, []);

  useEffect(() => {
    fetch("https://raw.githubusercontent.com/iceglober/glorious/main/CHANGELOG.md")
      .then((r) => r.text())
      .then((text) => setChangelog(cleanChangelog(text).trim() || "No releases yet."))
      .catch(() => setChangelog("Failed to load changelog."));
  }, []);

  return (
    <main className="site-main doc">
      <h1>Changelog</h1>

      <div className="changelog-content">
        {changelog ? (
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
            {changelog}
          </Markdown>
        ) : (
          <p>Loading...</p>
        )}
      </div>
    </main>
  );
}
