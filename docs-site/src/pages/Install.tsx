import { useEffect } from "react";
import { Cmd, PkgSwitcher } from "~/components/PkgManager";
import { CodeBlock } from "~/components/CodeBlock";

export function Install() {
  useEffect(() => {
    document.title = "install — glrs";
  }, []);

  return (
    <main className="site-main doc">
      <h1>Install</h1>

      <h2>Recommended</h2>

      <CodeBlock copy="curl -fsSL https://glrs.dev/install.sh | bash">
        curl -fsSL https://glrs.dev/install.sh | bash
      </CodeBlock>

      <p>Installs bun and glorious, and offers gh. Confirms before touching your system.</p>

      <hr />

      <h2>Manual</h2>

      <p>
        Requires <a href="https://bun.sh">Bun</a> ≥ 1.2 and git on PATH. Glorious ships on the{" "}
        <code>next</code> prerelease channel:
      </p>

      <CodeBlock copy="bun add --global @glrs-dev/glorious@next">
        bun add --global @glrs-dev/glorious@next
      </CodeBlock>

      <p>Or with another package manager:</p>

      <div className="pkg-bar">
        <PkgSwitcher />
      </div>

      <pre>
        <code>
          <Cmd action="install" pkg="@glrs-dev/glorious@next" />
        </code>
      </pre>

      <h2>First run</h2>

      <pre>
        <code>
          glorious config set --secret agent.llm.providers.azure.apiKey{"\n"}
          glorious
        </code>
      </pre>

      <p>
        Set your Azure AI Foundry key once (stored in the OS keychain), then open a session in any git
        repo. See the <a href="/quickstart">quickstart</a>.
      </p>

      <h2>Binaries</h2>

      <table>
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>glorious</code>
            </td>
            <td>the coding agent — chat session, or `run` one task</td>
          </tr>
          <tr>
            <td>
              <code>aj</code>
            </td>
            <td>short alias for `glorious`</td>
          </tr>
        </tbody>
      </table>

      <h2>Update</h2>

      <pre>
        <code>glorious update --channel next</code>
      </pre>

      <p>
        Installed sessions check for updates on startup and notify you; they never auto-install. See{" "}
        <a href="/config">config</a> (<code>update.auto</code>, <code>update.channel</code>).
      </p>

      <h2>Uninstall</h2>

      <pre>
        <code>
          <Cmd action="remove" pkg="@glrs-dev/glorious" />
        </code>
      </pre>
    </main>
  );
}
