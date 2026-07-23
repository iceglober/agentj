import { useState, useEffect } from "react";

const PACKAGE = { name: "@glrs-dev/glorious", label: "glorious", tag: "next" };

export function NpmVersions() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // Prerelease ships on the `next` dist-tag; fall back to latest.
    fetch(`https://registry.npmjs.org/${PACKAGE.name}`)
      .then((r) => r.json())
      .then((data) => {
        const tags = data["dist-tags"] ?? {};
        setVersion(tags[PACKAGE.tag] ?? tags.latest ?? null);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="npm-versions">
      <a
        href={`https://www.npmjs.com/package/${PACKAGE.name}`}
        className="npm-badge"
      >
        <span className="npm-label">{PACKAGE.label}</span>
        <span className="npm-version">{version ?? "..."}</span>
      </a>
    </div>
  );
}
