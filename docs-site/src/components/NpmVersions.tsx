import { useState, useEffect } from "react";

const PACKAGES = [
  { name: "@glrs-dev/cli", label: "cli" },
  { name: "@glrs-dev/harness-plugin-opencode", label: "harness" },
  { name: "@glrs-dev/assume", label: "assume" },
];

type VersionInfo = { name: string; label: string; version: string | null };

export function NpmVersions() {
  const [versions, setVersions] = useState<VersionInfo[]>(
    PACKAGES.map((p) => ({ ...p, version: null })),
  );

  useEffect(() => {
    PACKAGES.forEach((pkg, i) => {
      fetch(`https://registry.npmjs.org/${pkg.name}/latest`)
        .then((r) => r.json())
        .then((data) => {
          setVersions((prev) => {
            const next = [...prev];
            next[i] = { ...pkg, version: data.version ?? null };
            return next;
          });
        })
        .catch(() => {});
    });
  }, []);

  return (
    <div className="npm-versions">
      {versions.map((v) => (
        <a
          key={v.name}
          href={`https://www.npmjs.com/package/${v.name}`}
          className="npm-badge"
        >
          <span className="npm-label">{v.label}</span>
          <span className="npm-version">{v.version ?? "..."}</span>
        </a>
      ))}
    </div>
  );
}
