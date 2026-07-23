import { Link } from "react-router";
import { PkgSwitcher, Cmd } from "~/components/PkgManager";
import { NpmVersions } from "~/components/NpmVersions";

export function Home() {
  const copyBash = () =>
    navigator.clipboard.writeText("curl -fsSL https://glrs.dev/install.sh | bash");

  return (
    <main className="home">
      <div className="home-hero">
        <h1>glorious</h1>
        <p className="tagline">a terminal coding agent</p>
      </div>

      <NpmVersions />

      <div className="install-block">
        <div className="install-cmd" onClick={copyBash} title="copy to clipboard">
          curl -fsSL https://glrs.dev/install.sh | bash
        </div>
        <div className="install-alt">
          <div className="install-or">or via package manager:</div>
          <div className="install-alt-row">
            <PkgSwitcher />
            <Cmd action="install" pkg="@glrs-dev/glorious@next" />
          </div>
        </div>
      </div>

      <hr />

      <div className="links">
        <Link to="/install">install</Link>
        <Link to="/quickstart">quickstart</Link>
        <Link to="/modes">plan &amp; build modes</Link>
        <Link to="/cli">cli</Link>
        <Link to="/commands">commands &amp; keys</Link>
        <Link to="/config">configuration</Link>
        <Link to="/permissions">permissions</Link>
        <Link to="/subagents">parallel subagents</Link>
        <Link to="/jobs">background jobs</Link>
        <Link to="/skills">skills</Link>
        <Link to="/mcp">mcp servers</Link>
        <Link to="/tools">tools</Link>
        <Link to="/sessions">sessions</Link>
      </div>

      <div className="external">
        <Link to="/changelog">changelog</Link>
        {" · "}
        <a href="https://github.com/iceglober/glorious">github</a>
      </div>
    </main>
  );
}
