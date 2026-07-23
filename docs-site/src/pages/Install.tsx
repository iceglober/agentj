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

      <h2>Manual</h2>

      <p>
        Requires <a href="https://bun.sh">Bun</a> ≥ 1.2 and git.
      </p>

      <CodeBlock copy="bun add --global @glrs-dev/glorious@next">
        bun add --global @glrs-dev/glorious@next
      </CodeBlock>

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
        See the <a href="/quickstart">quickstart</a>.
      </p>

      <h2>Update</h2>

      <pre>
        <code>glorious update --channel next</code>
      </pre>

      <h2>Uninstall</h2>

      <pre>
        <code>
          <Cmd action="remove" pkg="@glrs-dev/glorious" />
        </code>
      </pre>
    </main>
  );
}
