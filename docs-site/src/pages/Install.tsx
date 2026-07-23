import { useEffect } from "react";
import { Cmd, PkgSwitcher, usePkgManager } from "~/components/PkgManager";
import { CodeBlock } from "~/components/CodeBlock";

const INSTALL_CMDS: Record<string, string> = {
  npm: "npm i -g @glrs-dev/cli",
  pnpm: "pnpm add -g @glrs-dev/cli",
  bun: "bun add -g @glrs-dev/cli",
  yarn: "yarn global add @glrs-dev/cli",
};

function ManualBlock() {
  const { mgr } = usePkgManager();
  const cmd = `${INSTALL_CMDS[mgr]}\nglrs harness install\nopencode`;
  return (
    <CodeBlock copy={cmd}>
      <Cmd action="install" pkg="@glrs-dev/cli" />{"\n"}glrs harness install{"\n"}opencode
    </CodeBlock>
  );
}

export function Install() {
  useEffect(() => { document.title = "install — glrs"; }, []);

  return (
    <main className="site-main doc">
      <h1>Install</h1>

      <h2>Recommended</h2>

      <CodeBlock copy="curl -fsSL https://glrs.dev/install.sh | bash">
        curl -fsSL https://glrs.dev/install.sh | bash
      </CodeBlock>

      <p>Installs bun, gh, and glrs. Confirms before touching your system.</p>

      <hr />

      <h2>Manual</h2>

      <div className="pkg-bar">
        <PkgSwitcher />
      </div>

      <p>Requires <a href="https://bun.sh">Bun</a> ≥ 1.2.0 on PATH.</p>

      <ManualBlock />

      <h2>Subcommands</h2>

      <table>
        <thead>
          <tr><th>Command</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><code>glrs harness</code></td><td>Plugin management (install, configure, uninstall, doctor)</td></tr>
          <tr><td><code>glrs wt</code></td><td>Worktree management (create, list, switch, delete, cleanup)</td></tr>
          <tr><td><code>glrs autopilot</code></td><td>Autonomous scope → plan → execute orchestrator</td></tr>
          <tr><td><code>glrs loop</code></td><td>Raw prompt loop runner</td></tr>
          <tr><td><code>glrs upgrade</code></td><td>Self-update to latest version</td></tr>
        </tbody>
      </table>

      <h2>Assume (optional, separate)</h2>

      <pre><code><Cmd action="install" pkg="@glrs-dev/assume" /></code></pre>

      <p>Standalone Rust binary for AWS/GCP SSO.</p>

      <h2>Update</h2>

      <pre><code><Cmd action="update" pkg="@glrs-dev/cli" /></code></pre>

      <h2>Uninstall</h2>

      <pre><code>glrs harness uninstall{"\n"}<Cmd action="remove" pkg="@glrs-dev/cli" /></code></pre>
    </main>
  );
}
