import { useState, useEffect } from "react";
import { Link } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PACKAGES = [
  { key: "harness", label: "harness", file: "harness-opencode" },
  { key: "cli", label: "cli", file: "cli" },
  { key: "assume", label: "assume", file: "assume" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MdLink({ href, children }: { href?: string; children?: any }) {
  if (href && href.startsWith("/")) {
    return <Link to={href}>{children}</Link>;
  }
  return <a href={href}>{children}</a>;
}

function cleanChangelog(raw: string): string {
  return raw
    // Strip the h1 title line (e.g. "# @glrs-dev/harness-plugin-opencode")
    .replace(/^#\s+@glrs-dev\/.*\n+/, "")
    // Remove empty version sections (just "## X.Y.Z" with no content before next heading)
    .replace(/^(## \d+\.\d+\.\d+)\n+(## )/gm, "$2");
}

export function Changelog() {
  const [active, setActive] = useState("harness");
  const [changelogs, setChangelogs] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "changelog — glrs";
  }, []);

  useEffect(() => {
    if (changelogs[active]) return;

    const pkg = PACKAGES.find((p) => p.key === active);
    if (!pkg) return;

    fetch(
      `https://raw.githubusercontent.com/iceglober/glrs/main/packages/${pkg.file}/CHANGELOG.md`,
    )
      .then((r) => r.text())
      .then((text) => {
        setChangelogs((prev) => ({ ...prev, [active]: cleanChangelog(text) }));
      })
      .catch(() => {
        setChangelogs((prev) => ({
          ...prev,
          [active]: "Failed to load changelog.",
        }));
      });
  }, [active, changelogs]);

  return (
    <main className="site-main doc">
      <h1>Changelog</h1>

      <div className="changelog-tabs">
        {PACKAGES.map((pkg) => (
          <button
            key={pkg.key}
            className={active === pkg.key ? "active" : ""}
            onClick={() => setActive(pkg.key)}
          >
            {pkg.label}
          </button>
        ))}
      </div>

      <div className="changelog-content">
        {changelogs[active] ? (
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
            {changelogs[active]}
          </Markdown>
        ) : (
          <p>Loading...</p>
        )}
      </div>
    </main>
  );
}
